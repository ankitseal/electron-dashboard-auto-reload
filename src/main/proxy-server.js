const http = require('http');
const fs = require('fs');
const path = require('path');
const urlLib = require('url');
const { OffscreenRenderer } = require('./offscreen-renderer');
const WebSocket = require('ws');

// Persist created links in userData folder alongside config.json
function linksFile(userDataPath) {
	try { return path.join(userDataPath || path.join(process.cwd(), '.data'), 'proxy-links.json'); } catch { return path.join(process.cwd(), 'proxy-links.json'); }
}
function normalizeStreamUrl(raw) {
	const txt = typeof raw === 'string' ? raw.trim() : '';
	if (!txt) return null;
	const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(txt);
	const candidate = hasScheme ? txt : `https://${txt}`;
	try {
		const parsed = new urlLib.URL(candidate);
		if (!/^https?:$/i.test(parsed.protocol || '')) return null;
		parsed.hash = '';
		return parsed.toString();
	} catch {
		return null;
	}
}
function sanitizeLinkRecord(entry) {
	if (!entry || typeof entry !== 'object') return null;
	const id = String(entry.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30);
	const url = normalizeStreamUrl(entry.url);
	if (!id || !url) return null;
	const createdAt = Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Date.now();
	return { id, url, createdAt };
}
function sanitizeLinkList(list) {
	const seen = new Set();
	const out = [];
	if (Array.isArray(list)) {
		for (const item of list) {
			const clean = sanitizeLinkRecord(item);
			if (!clean) continue;
			if (seen.has(clean.id)) continue;
			seen.add(clean.id);
			out.push(clean);
		}
	}
	return out;
}
function readLinks(userDataPath) {
	try {
		const p = linksFile(userDataPath);
		if (fs.existsSync(p)) {
			const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
			return sanitizeLinkList(parsed);
		}
	} catch {}
	return [];
}
function writeLinks(userDataPath, list) {
	try {
		const p = linksFile(userDataPath);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(sanitizeLinkList(list), null, 2));
	} catch {}
}

// Removed legacy listIPs and /api/ips endpoint; UI no longer consumes it.

function parseJsonBody(req) {
	return new Promise((resolve) => {
		let buf = '';
		req.on('data', (d) => { buf += d; if (buf.length > 2 * 1024 * 1024) { try { req.destroy(); } catch {}; resolve(null); } });
		req.on('end', () => {
			try { resolve(JSON.parse(buf || '{}')); } catch { resolve(null); }
		});
		req.on('error', () => resolve(null));
	});
}

// Simple router helpers
function resolveAllowedOrigin(req) {
	try {
		const origin = req && req.headers ? req.headers.origin : '';
		if (!origin) return null;
		const originUrl = new urlLib.URL(origin);
		const host = (req.headers && req.headers.host) ? String(req.headers.host) : '';
		if (host && originUrl.host.toLowerCase() === host.toLowerCase()) {
			return origin;
		}
	} catch {}
	return null;
}
function sendJSON(req, res, obj, status = 200) {
	const body = Buffer.from(JSON.stringify(obj));
	const origin = resolveAllowedOrigin(req);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {})
	});
	res.end(body);
}
function sendText(req, res, text, status = 200, headers = {}) {
	const origin = resolveAllowedOrigin(req);
	res.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
		...headers
	});
	res.end(text);
}
function notFound(req, res) { sendText(req, res, 'Not found', 404); }

async function startReverseProxyServer(options) {
	const host = options.host || '0.0.0.0';
	const port = Number.isFinite(Number(options.port)) ? Number(options.port) : 7993;
	const partition = options.partition; // Electron session partition string
	const getConfig = options.getConfig || (() => ({}));
	const userDataPath = options.userDataPath || null;
	const preloadPath = options.preloadPath || null;

		const instances = new Map(); // id -> OffscreenRenderer
		const wsClients = new Map(); // id -> Set(ws)

	async function ensureOrCreate(id) {
		let inst = instances.get(id);
		if (inst) return inst;
		// Try to rehydrate from persisted links
		try {
			const links = readLinks(userDataPath);
			const rec = links.find(l => l && l.id === id);
			if (rec && rec.url) {
				const safeUrl = normalizeStreamUrl(rec.url);
				if (!safeUrl) return null;
				const renderer = new OffscreenRenderer({ id, url: safeUrl, partition, preloadPath, cfgProvider: () => getConfig() });
				instances.set(id, renderer);
				attachFrameForwarder(id, renderer);
				await renderer.start();
				return renderer;
			}
		} catch {}
		return null;
	}

	function makeId() { return (Math.random().toString(36).slice(2, 6) + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]/gi, '').slice(0, 20); }

	// Wire frame broadcasting
	function attachFrameForwarder(id, renderer) {
		let first = true;
		renderer.onFrame((jpeg) => {
			// WebSocket (binary JPEG only)
			const wset = wsClients.get(id);
			if (wset && wset.size) {
				for (const ws of Array.from(wset)) {
					try { if (ws.readyState === WebSocket.OPEN) ws.send(jpeg, { binary: true }); } catch { try { wset.delete(ws); } catch {} }
				}
			}
			if (first && jpeg && jpeg.length) { first = false; try { console.log(`[proxy:${id}] broadcasting first frame ${jpeg.length} bytes to ${wset ? wset.size : 0} clients`); } catch {} }
		});
	}

	function serveFile(req, res, filePath, contentType) {
		try {
			const data = fs.readFileSync(filePath);
			res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
			res.end(data);
		} catch {
			notFound(req, res);
		}
	}

	const router = async (req, res) => {
		const parsed = urlLib.parse(req.url, true);
		const pathname = decodeURIComponent(parsed.pathname || '/');
		// CORS preflight
		if (req.method === 'OPTIONS') {
			const origin = resolveAllowedOrigin(req);
			const headers = {
				'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type'
			};
			if (origin) {
				headers['Access-Control-Allow-Origin'] = origin;
				headers.Vary = 'Origin';
			}
			res.writeHead(204, headers);
			return res.end();
		}

		// Static assets
		const indexPath = path.join(__dirname, '..', 'renderer', 'proxy', 'index.html');
		const swPath = path.join(__dirname, '..', 'renderer', 'proxy', 'sw.js');
		if (req.method === 'GET' && pathname === '/sw.js') return serveFile(req, res, swPath, 'text/javascript; charset=utf-8');
		if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/view/'))) {
			return serveFile(req, res, indexPath, 'text/html; charset=utf-8');
		}

		// (Removed) /api/ips legacy endpoint

		// No signaling endpoints

		if (req.method === 'GET' && pathname === '/api/list') {
			const list = readLinks(userDataPath);
			return sendJSON(req, res, { ok: true, list });
		}

		if (req.method === 'POST' && pathname === '/api/create') {
			const payload = await parseJsonBody(req);
			if (!payload || typeof payload.url !== 'string') {
				return sendJSON(req, res, { ok: false, error: 'Missing url' }, 400);
			}
			const cleanUrl = normalizeStreamUrl(payload.url);
			if (!cleanUrl) {
				return sendJSON(req, res, { ok: false, error: 'URL must use http(s)' }, 400);
			}
			const links = readLinks(userDataPath);
			const existing = links.find((rec) => rec && rec.url === cleanUrl);
			if (existing && existing.id) {
				return sendJSON(req, res, { ok: true, id: existing.id, existing: true, view: `/view/${existing.id}`, ws: `/ws/${existing.id}` });
			}

			// Create new stream
			const id = makeId();
			const renderer = new OffscreenRenderer({ id, url: cleanUrl, partition, preloadPath, cfgProvider: () => getConfig() });
			instances.set(id, renderer);
			attachFrameForwarder(id, renderer);
			if (payload.width && payload.height) {
				try { await renderer.resize(payload.width, payload.height); } catch {}
			}
			await renderer.start();
			links.unshift({ id, url: cleanUrl, createdAt: Date.now() });
			writeLinks(userDataPath, links.slice(0, 1000));
			return sendJSON(req, res, { ok: true, id, view: `/view/${id}`, ws: `/ws/${id}` });
		}

		// Delete stream
		if (req.method === 'POST' && pathname.startsWith('/api/delete/')) {
			const id = pathname.split('/').pop();
			try {
				// Close renderer if active
				const inst = instances.get(id);
				if (inst && inst.close) { try { await inst.close(); } catch {} }
				try { instances.delete(id); } catch {}
				// Close WS clients
				const wset = wsClients.get(id);
				if (wset && wset.size) {
					for (const ws of Array.from(wset)) { try { ws.close(); } catch {} }
				}
				try { wsClients.delete(id); } catch {}
				const links = readLinks(userDataPath) || [];
				const next = links.filter((rec) => !(rec && rec.id === id));
				writeLinks(userDataPath, next);
				return sendJSON(req, res, { ok: true, id });
			} catch (err) {
				return sendJSON(req, res, { ok: false, error: String(err && err.message ? err.message : err) }, 500);
			}
		}

		// No MJPEG endpoint; WebSocket is the only transport

		if (req.method === 'POST' && pathname.startsWith('/api/input/')) {
			const id = pathname.split('/').pop();
			const renderer = await ensureOrCreate(id);
			if (!renderer) return notFound(req, res);
			const payload = await parseJsonBody(req);
			if (!payload) return sendJSON(req, res, { ok: false, error: 'bad json' }, 400);
			try { await renderer.forwardInput(payload); } catch {}
			return sendJSON(req, res, { ok: true });
		}

		if (req.method === 'POST' && pathname.startsWith('/api/resize/')) {
			const id = pathname.split('/').pop();
			const renderer = await ensureOrCreate(id);
			if (!renderer) return notFound(req, res);
			const payload = await parseJsonBody(req);
			if (!payload) return sendJSON(req, res, { ok: false, error: 'bad json' }, 400);
			const w = Number(payload.width), h = Number(payload.height);
			try { await renderer.resize(w, h); } catch {}
			return sendJSON(req, res, { ok: true });
		}

		return notFound(req, res);
	};

		const server = http.createServer(router);
		// Attach WebSocket for /ws/:id
		const wss = new WebSocket.Server({ noServer: true });
		server.on('upgrade', async (req, socket, head) => {
			try {
				const parsed = urlLib.parse(req.url || '/', true);
				const pathname = decodeURIComponent(parsed.pathname || '/');
				if (!pathname.startsWith('/ws/')) return socket.destroy();
				const id = pathname.split('/').pop();
				const inst = await ensureOrCreate(id);
				if (!inst) return socket.destroy();
				wss.handleUpgrade(req, socket, head, (ws) => {
					let set = wsClients.get(id); if (!set) { set = new Set(); wsClients.set(id, set); }
					set.add(ws);
					ws.on('close', () => { try { set.delete(ws); } catch {} });
					// Optional: send a hello JSON
					try { ws.send(JSON.stringify({ ok: true, id })); } catch {}
					// If we have a last frame already, push it immediately to avoid initial blank
					try {
						const frame = inst.getLastFrame && inst.getLastFrame();
						if (frame && frame.length && ws.readyState === WebSocket.OPEN) {
							ws.send(frame, { binary: true });
						}
					} catch {}
				});
			} catch { try { socket.destroy(); } catch {} }
		});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});

	try { console.log(`[reverse-proxy] listening on ${host}:${port}`); } catch {}

	const handle = {
		close: () => new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } }),
		list: () => readLinks(userDataPath)
	};
	return handle;
}

module.exports = { startReverseProxyServer };

