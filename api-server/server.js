const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3001;
const WEB_ROOT = path.join(__dirname, '..');
const CREDENTIALS = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8'));
const COUNTER_FILE = path.join(WEB_ROOT, 'data', 'counter.json');

// Session store: token -> { username, expires }
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

function verifyPassword(password) {
  const hash = crypto.createHash('sha256').update(CREDENTIALS.salt + password).digest('hex');
  return hash === CREDENTIALS.hash;
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL });
  return token;
}

function validateSession(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) { sessions.delete(token); return null; }
  return session;
}

function getCounter() {
  try {
    const data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.date !== today) {
      data.today = 0;
      data.date = today;
    }
    return data;
  } catch {
    return { total: 0, today: 0, date: new Date().toISOString().split('T')[0] };
  }
}

function saveCounter(data) {
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // --- Login ---
  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString());
      if (body.username === CREDENTIALS.username && verifyPassword(body.password)) {
        const token = createSession(body.username);
        return json(res, { token, username: body.username });
      }
      return json(res, { error: '用户名或密码错误' }, 401);
    } catch { return json(res, { error: '请求格式错误' }, 400); }
  }

  // --- Session check ---
  if (pathname === '/api/session' && req.method === 'GET') {
    const session = validateSession(req);
    if (session) return json(res, { username: session.username });
    return json(res, { error: '未登录' }, 401);
  }

  // --- Logout ---
  if (pathname === '/api/logout' && req.method === 'POST') {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) sessions.delete(auth.slice(7));
    return json(res, { ok: true });
  }

  // --- Counter ---
  if (pathname === '/api/counter' && req.method === 'GET') {
    const data = getCounter();
    data.total++;
    data.today++;
    saveCounter(data);
    return json(res, { total: data.total, today: data.today });
  }

  // --- Save data (announcements.json / news.json) ---
  const dataMatch = pathname.match(/^\/api\/data\/([\w.-]+)$/);
  if (dataMatch && req.method === 'PUT') {
    if (!validateSession(req)) return json(res, { error: '未登录' }, 401);
    const filename = dataMatch[1];
    if (!['announcements.json', 'news.json'].includes(filename)) {
      return json(res, { error: '不允许的文件' }, 403);
    }
    try {
      const body = await readBody(req);
      const data = JSON.parse(body.toString());
      fs.writeFileSync(path.join(WEB_ROOT, 'data', filename), JSON.stringify(data, null, 2));
      return json(res, { ok: true });
    } catch { return json(res, { error: '保存失败' }, 500); }
  }

  // --- Upload image ---
  if (pathname === '/api/upload' && req.method === 'POST') {
    if (!validateSession(req)) return json(res, { error: '未登录' }, 401);
    try {
      const body = await readBody(req);
      const contentType = req.headers['content-type'] || '';

      if (!contentType.includes('multipart/form-data')) {
        return json(res, { error: '需要 multipart/form-data' }, 400);
      }

      const boundary = contentType.split('boundary=')[1];
      if (!boundary) return json(res, { error: '缺少 boundary' }, 400);

      // Parse multipart manually (no dependencies)
      const parts = parseMultipart(body, boundary);
      const filePart = parts.find(p => p.name === 'file');
      if (!filePart) return json(res, { error: '缺少文件' }, 400);

      if (filePart.data.length > 5 * 1024 * 1024) {
        return json(res, { error: '文件大小不能超过 5MB' }, 400);
      }

      const safeName = (filePart.filename || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = `data/images/${Date.now()}_${safeName}`;
      const fullPath = path.join(WEB_ROOT, filePath);

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, filePart.data);
      return json(res, { path: filePath });
    } catch (e) {
      console.error('Upload error:', e.message);
      return json(res, { error: '上传失败' }, 500);
    }
  }

  json(res, { error: 'Not Found' }, 404);
});

// Simple multipart parser
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const endBuf = Buffer.from('--' + boundary + '--');

  let start = bufferIndexOf(buffer, boundaryBuf, 0);
  if (start === -1) return parts;

  while (true) {
    start += boundaryBuf.length;
    // Skip \r\n after boundary
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    const nextBoundary = bufferIndexOf(buffer, boundaryBuf, start);
    if (nextBoundary === -1) break;

    const partData = buffer.slice(start, nextBoundary);
    // Find header/body separator \r\n\r\n
    const headerEnd = bufferIndexOf(partData, Buffer.from('\r\n\r\n'), 0);
    if (headerEnd === -1) { start = nextBoundary; continue; }

    const headerStr = partData.slice(0, headerEnd).toString();
    let body = partData.slice(headerEnd + 4);
    // Remove trailing \r\n before next boundary
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.slice(0, body.length - 2);
    }

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      data: body,
    });

    // Check if next boundary is the end
    if (bufferIndexOf(buffer, endBuf, nextBoundary) === nextBoundary) break;
    start = nextBoundary;
  }
  return parts;
}

function bufferIndexOf(buf, search, offset) {
  for (let i = offset; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expires) sessions.delete(token);
  }
}, 60 * 60 * 1000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`API server running on http://127.0.0.1:${PORT}`);
});
