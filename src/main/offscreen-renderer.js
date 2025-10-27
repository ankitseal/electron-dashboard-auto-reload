const { BrowserWindow } = require('electron');
const urlLib = require('url');

function normalizeUrl(u) {
	if (!u) return 'about:blank';
	const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u);
	return hasScheme ? u : ('https://' + u);
}
function stripFromTo(urlStr) {
	try { const u = new urlLib.URL(urlStr); u.searchParams.delete('from'); u.searchParams.delete('to'); u.hash = ''; return u.toString(); } catch { return urlStr; }
}
function durationToMs(label) {
	const map = { '1h':3600000,'2h':7200000,'6h':21600000,'12h':43200000,'1d':86400000,'2d':172800000,'5d':432000000,'7d':604800000 };
	if (map[label]) return map[label];
	const h = parseInt(String(label||'').replace(/[^0-9]/g,''),10);
	return Number.isFinite(h) && h>0 ? h*3600000 : 86400000;
}
function computeWindow(startHM, durationLabel) {
	const parts = String(startHM||'12:00').split(':');
	const sh = Math.max(0, Math.min(23, parseInt(parts[0]||'12',10)||0));
	const sm = Math.max(0, Math.min(59, parseInt(parts[1]||'0',10)||0));
	const now = new Date();
	const durMs = durationToMs(durationLabel||'1d');
	const dayMs = 86400000;
	let from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0, 0);
	if (now < from) from = new Date(from.getTime() - dayMs);
	let to = new Date(from.getTime() + durMs);
	while (now >= to) { from = new Date(from.getTime() + dayMs); to = new Date(from.getTime() + durMs); }
	return { from: from.getTime(), to: to.getTime() };
}
function withWindowParams(urlStr, win) {
	try { const u = new urlLib.URL(urlStr); u.searchParams.set('from', String(win.from)); u.searchParams.set('to', String(win.to)); return u.toString(); } catch { return urlStr; }
}

class OffscreenRenderer {
	constructor({ id, url, partition, preloadPath, cfgProvider }) {
		this.id = id;
		this.url = normalizeUrl(url);
		this.partition = partition;
		this.preloadPath = preloadPath;
		this.cfgProvider = cfgProvider || (() => ({}));
		this.win = null;
		this.lastFrame = null;
		this.subscribers = new Set();
		this._paintHandler = null;
		this._timer = null;
		this._base = stripFromTo(this.url);
		this._size = { width: 1366, height: 768 };
		this._firstFrameLogged = false;
	}

	async start() {
		if (this.win) return;
		const webPreferences = {
			offscreen: true,
			preload: this.preloadPath || undefined,
			partition: this.partition,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			backgroundThrottling: false,
			enableRemoteModule: false
		};
		this.win = new BrowserWindow({
			show: false,
			width: this._size.width,
			height: this._size.height,
			backgroundColor: '#000000',
			paintWhenInitiallyHidden: true,
			webPreferences
		});
		const wc = this.win.webContents;
		try { wc.setFrameRate(30); } catch {}
		// Basic load diagnostics
		try {
			wc.on('did-finish-load', () => { try { console.log(`[offscreen:${this.id}] did-finish-load ${wc.getURL()}`); } catch {} });
			wc.once('did-fail-load', (_e, errorCode, errorDesc, validatedURL) => { try { console.log(`[offscreen:${this.id}] did-fail-load ${errorCode} ${errorDesc} url=${validatedURL}`); } catch {} });
			wc.on('dom-ready', () => { try { console.log(`[offscreen:${this.id}] dom-ready`); } catch {} });
			wc.on('did-navigate', (_e, url) => { try { console.log(`[offscreen:${this.id}] did-navigate ${url}`); } catch {} });
			wc.on('did-navigate-in-page', (_e, url) => { try { console.log(`[offscreen:${this.id}] did-navigate-in-page ${url}`); } catch {} });
		} catch {}
		this._paintHandler = (_e, _dirty, image) => {
			try {
				// Increase JPEG quality for crisper text; consider PNG for static frames in future
				this.lastFrame = image.toJPEG(92);
				if (!this._firstFrameLogged && this.lastFrame && this.lastFrame.length) {
					try { console.log(`[offscreen:${this.id}] first frame ${this.lastFrame.length} bytes`); } catch {}
					this._firstFrameLogged = true;
				}
			} catch {}
			// fan out via callbacks
			for (const cb of Array.from(this.subscribers)) {
				try { cb(this.lastFrame); } catch {}
			}
		};
		wc.on('paint', this._paintHandler);
		// Navigate initial with possible rolling window
		await this._navigateToCurrent();
		this._startWatchdog();
	}

	async _navigateToCurrent() {
		const cfg = this.cfgProvider() || {};
		const tw = cfg.timeWindow || { enabled: false, start: '12:00', duration: '1d' };
		const url = tw.enabled ? withWindowParams(this._base, computeWindow(tw.start, tw.duration)) : this._base;
		try { await this.win.loadURL(url); } catch {}
	}

	_startWatchdog() {
		const wc = this.win.webContents;
		const check = () => {
			try {
				const cfg = this.cfgProvider() || {};
				const tw = cfg.timeWindow || { enabled: false, start: '12:00', duration: '1d' };
				const navBack = !!cfg.navigateBackEnabled;
				const tabTimeoutSec = Number.isFinite(cfg.tabTimeoutSec) ? cfg.tabTimeoutSec : 0;
				const current = wc.getURL();
				const curBase = stripFromTo(current);
				if (navBack && tabTimeoutSec > 0 && curBase && curBase !== stripFromTo(withWindowParams(this._base, { from: 0, to: 0 }))) {
					// If off-target, after grace redirect to base
					this._offSince = this._offSince || Date.now();
					if (Date.now() - this._offSince >= tabTimeoutSec * 1000) {
						this._offSince = null;
						this._navigateToCurrent();
						return;
					}
				} else {
					this._offSince = null;
				}
				// Rolling window sync
				if (tw.enabled) {
					const desired = computeWindow(tw.start, tw.duration);
					try {
						const u = new urlLib.URL(current);
						const curFrom = Number(u.searchParams.get('from') || 0);
						const curTo = Number(u.searchParams.get('to') || 0);
						const driftOk = 5000;
						if (Math.abs(curFrom - desired.from) > driftOk || Math.abs(curTo - desired.to) > driftOk) {
							const dest = withWindowParams(this._base, desired);
							this.win.loadURL(dest).catch(()=>{});
						}
					} catch {}
				}
			} catch {}
		};
		this._timer = setInterval(check, 5000);
		this.win.on('closed', () => { try { clearInterval(this._timer); } catch {}; this._timer = null; });
	}

	onFrame(cb) { this.subscribers.add(cb); return () => this.subscribers.delete(cb); }
	getLastFrame() { return this.lastFrame; }

		async resize(width, height) {
			const w = Math.max(320, Math.min(3840, Math.floor(Number(width) || 1366)));
			const h = Math.max(240, Math.min(2160, Math.floor(Number(height) || 768)));
			this._size = { width: w, height: h };
			try { if (this.win && !this.win.isDestroyed()) this.win.setSize(w, h); } catch {}
		}

	async forwardInput(ev) {
		if (!this.win) return;
		const wc = this.win.webContents;
		const W = this._size.width, H = this._size.height;
		const type = ev && ev.type;
		if (!type) return;
		if (type.startsWith('mouse')) {
			const x = Math.max(0, Math.min(W - 1, Math.round((ev.x || 0) * W)));
			const y = Math.max(0, Math.min(H - 1, Math.round((ev.y || 0) * H)));
			if (type === 'mouseMove') {
				wc.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
			} else if (type === 'mouseDown' || type === 'mouseUp') {
				const button = ev.button || 'left';
				wc.sendInputEvent({ type, x, y, button, clickCount: 1 });
			} else if (type === 'mouseWheel') {
				wc.sendInputEvent({ type: 'mouseWheel', deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0, x, y });
			}
			return;
		}
		if (type === 'keyDown' || type === 'keyUp' || type === 'char') {
			const keyCode = ev.keyCode || ev.key || '';
			wc.sendInputEvent({ type, keyCode });
			return;
		}
	}

	async close() {
		try { if (this.win && !this.win.isDestroyed()) this.win.close(); } catch {}
	}
}

module.exports = { OffscreenRenderer };

