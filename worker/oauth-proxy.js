// GitHub OAuth + API Proxy for Cloudflare Workers
// 功能：1. OAuth token 交换  2. GitHub API 代理加速（国内加速）

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ===== OAuth token 交换 =====
    if (url.pathname === '/api/oauth/token' && request.method === 'POST') {
      try {
        const { code, code_verifier } = await request.json();
        if (!code) {
          return jsonResp({ error: 'Missing code parameter' }, 400, corsHeaders);
        }

        const tokenBody = {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        };
        if (code_verifier) tokenBody.code_verifier = code_verifier;

        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(tokenBody),
        });

        const tokenData = await tokenResponse.json();
        return jsonResp(tokenData, tokenResponse.ok ? 200 : 400, corsHeaders);
      } catch {
        return jsonResp({ error: 'Token exchange failed' }, 500, corsHeaders);
      }
    }

    // ===== 访问计数器 =====
    if (url.pathname === '/api/counter' && request.method === 'GET') {
      try {
        const count = parseInt(await env.COUNTER.get('page_views') || '0') + 1;
        await env.COUNTER.put('page_views', count.toString());
        return jsonResp({ count }, 200, corsHeaders);
      } catch {
        return jsonResp({ count: 0 }, 200, corsHeaders);
      }
    }

    // ===== GitHub API 代理 =====
    if (url.pathname.startsWith('/api/github/')) {
      const githubPath = url.pathname.replace('/api/github/', '');
      const githubUrl = `https://api.github.com/${githubPath}${url.search}`;

      const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'cloudflare-worker-proxy',
      };
      const authHeader = request.headers.get('Authorization');
      if (authHeader) headers['Authorization'] = authHeader;

      try {
        const ghResp = await fetch(githubUrl, {
          method: request.method,
          headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
        });

        const respHeaders = { ...corsHeaders, 'Content-Type': ghResp.headers.get('Content-Type') || 'application/json' };
        return new Response(ghResp.body, { status: ghResp.status, headers: respHeaders });
      } catch {
        return jsonResp({ error: 'GitHub API proxy failed' }, 502, corsHeaders);
      }
    }

    return jsonResp({ error: 'Not Found' }, 404, corsHeaders);
  },
};

function jsonResp(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
