// GitHub OAuth Token Exchange Proxy for Cloudflare Workers
// 部署步骤：
// 1. 安装 wrangler: npm install -g wrangler
// 2. 登录: wrangler login
// 3. 设置 secrets:
//    wrangler secret put GITHUB_CLIENT_ID
//    wrangler secret put GITHUB_CLIENT_SECRET
//    wrangler secret put ALLOWED_ORIGIN
// 4. 部署: wrangler deploy

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/oauth/token' && request.method === 'POST') {
      try {
        const { code } = await request.json();

        if (!code) {
          return new Response(JSON.stringify({ error: 'Missing code parameter' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Exchange code for access token
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code: code,
          }),
        });

        const tokenData = await tokenResponse.json();

        return new Response(JSON.stringify(tokenData), {
          status: tokenResponse.ok ? 200 : 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Token exchange failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
