// Tiny HTTP server with landing page and GET /open?url=...
// Calls provided onOpen(url) and never exposes credentials/tokens.
// Export startLocalServer({ host, port, onOpen }) and return a handle with close().

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

function json(res, status, body) {
  try { res.statusCode = status; } catch {}
  try { res.setHeader('Content-Type', 'application/json; charset=utf-8'); } catch {}
  try { res.end(JSON.stringify(body)); } catch {}
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) { try { req.destroy(); } catch {}; } });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

function injectSettingsShim(html) {
  const shim = `\n<script>(function(){\n  if(!window.Settings){\n    const j = (m,u,b)=>fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined}).then(r=>r.json());\n    window.Settings = {\n      getConfig: ()=> j('GET','/api/get-config'),\n      saveConfig: (p)=> j('POST','/api/save-config',p),\n      getVersion: ()=> j('GET','/api/version'),\n      setNtpPreference: (p)=> j('POST','/api/set-ntp-preference',p),\n      setProxyPreference: (p)=> j('POST','/api/set-proxy-preference',p),\n      get2FAState: ()=> j('GET','/api/get-2fa-state'),\n      set2FAEnabled: (v)=> j('POST','/api/set-2fa-enabled',{ enabled: !!v }),\n      set2FASecret: (s)=> j('POST','/api/set-2fa-secret',{ secret: s }),\n      remove2FASecret: ()=> j('POST','/api/remove-2fa-secret'),\n      getTotpCode: ()=> j('GET','/api/get-totp-code')\n    };\n  }\n})();</script>\n`;
  return html.replace(/<\/head>/i, shim + '</head>');
}

function startLocalServer({ host = '0.0.0.0', port = 793, onOpen, onGetConfig, onSaveConfig, onGetVersion, onSetNtpPreference, onSetProxyPreference, onGet2FAState, onSet2FAEnabled, onSet2FASecret, onRemove2FASecret, onGetTotpCode }) {
  if (typeof onOpen !== 'function') throw new Error('onOpen callback is required');

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://${host}:${port}`);
      const pathname = reqUrl.pathname || '';
      if (req.method !== 'GET') {
        // Allow POST for API endpoints
        if (!pathname.startsWith('/api/')) {
          return json(res, 405, { ok: false, error: 'method not allowed' });
        }
      }

      if (pathname === '/') {
        // Serve Settings UI at base URL
        try {
          const filePath = path.join(__dirname, '..', 'renderer', 'settings', 'index.html');
          let raw = fs.readFileSync(filePath, 'utf-8');
          raw = injectSettingsShim(raw);
          res.statusCode = 200; res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(raw);
        } catch (err) {
          return json(res, 500, { ok: false, error: 'failed to load settings page' });
        }
      }

      if (pathname === '/settings') {
        try {
          // Serve the app's Settings page with a shim that calls our REST endpoints
          const filePath = path.join(__dirname, '..', 'renderer', 'settings', 'index.html');
          let raw = fs.readFileSync(filePath, 'utf-8');
          raw = injectSettingsShim(raw);
          res.statusCode = 200; res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(raw);
        } catch (err) {
          return json(res, 500, { ok: false, error: 'failed to load settings page' });
        }
      }

      // --- JSON API ---
      if (pathname === '/api/get-config') {
        try { const cfg = await (onGetConfig ? onGetConfig() : {}); return json(res, 200, cfg); } catch { return json(res, 500, { ok:false, error:'failed' }); }
      }
      if (pathname === '/api/version') {
        try { const v = await (onGetVersion ? onGetVersion() : { version: '' }); return json(res, 200, v); } catch { return json(res, 200, { version: '' }); }
      }
      if (pathname === '/api/save-config' && req.method === 'POST') {
        const body = await parseBody(req);
        try { const out = await (onSaveConfig ? onSaveConfig(body) : { ok:false }); return json(res, 200, out); } catch (e) { return json(res, 500, { ok:false, error:'save failed' }); }
      }
      if (pathname === '/api/set-ntp-preference' && req.method === 'POST') {
        const body = await parseBody(req); try { const out = await (onSetNtpPreference ? onSetNtpPreference(body) : { ok:false }); return json(res, 200, out); } catch { return json(res, 500, { ok:false }); }
      }
      if (pathname === '/api/set-proxy-preference' && req.method === 'POST') {
        const body = await parseBody(req); try { const out = await (onSetProxyPreference ? onSetProxyPreference(body) : { ok:false }); return json(res, 200, out); } catch { return json(res, 500, { ok:false }); }
      }
      if (pathname === '/api/get-2fa-state') { try { const s = await (onGet2FAState ? onGet2FAState() : { enabled:false, hasSecret:false }); return json(res, 200, s); } catch { return json(res, 200, { enabled:false, hasSecret:false }); } }
      if (pathname === '/api/set-2fa-enabled' && req.method === 'POST') { const body = await parseBody(req); try { const r = await (onSet2FAEnabled ? onSet2FAEnabled(body.enabled) : { ok:false }); return json(res, 200, r); } catch { return json(res, 500, { ok:false }); } }
      if (pathname === '/api/set-2fa-secret' && req.method === 'POST') { const body = await parseBody(req); try { const r = await (onSet2FASecret ? onSet2FASecret(body.secret) : { ok:false }); return json(res, 200, r); } catch { return json(res, 500, { ok:false }); } }
      if (pathname === '/api/remove-2fa-secret' && req.method === 'POST') { try { const r = await (onRemove2FASecret ? onRemove2FASecret() : { ok:false }); return json(res, 200, r); } catch { return json(res, 500, { ok:false }); } }
      if (pathname === '/api/get-totp-code') { try { const r = await (onGetTotpCode ? onGetTotpCode() : ''); return json(res, 200, r); } catch { return json(res, 200, ''); } }


      if (pathname === '/open') {
        const target = reqUrl.searchParams.get('url') || '';
        let parsed = null;
        try { parsed = new URL(target); } catch {}
        if (!parsed) {
          return json(res, 400, { ok: false, error: 'invalid url' });
        }
        const proto = (parsed.protocol || '').toLowerCase();
        if (proto !== 'http:' && proto !== 'https:') {
          return json(res, 400, { ok: false, error: 'unsupported protocol' });
        }
        try {
          const result = onOpen(parsed.toString());
          if (result && typeof result.then === 'function') {
            await result; // await async callback
          }
          return json(res, 200, { ok: true, loaded: parsed.toString() });
        } catch (err) {
          return json(res, 500, { ok: false, error: 'failed to open' });
        }
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return json(res, 500, { ok: false, error: 'internal error' });
    }
  });

  // Track sockets so we can force-close on restart
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.keepAliveTimeout = 1000;
  server.requestTimeout = 5000;

  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e));
    server.listen({ host, port }, () => {
      try { console.log(`[loopback] listening on ${host}:${port}`); } catch {}
      resolve({ close: () => new Promise((res) => {
        try {
          server.close(() => res());
          // Force close lingering sockets after a short grace
          setTimeout(() => { try { for (const s of sockets) { try { s.destroy(); } catch {} } } catch {} }, 300);
        } catch { res(); }
      }) });
    });
  });
}

module.exports = { startLocalServer };
