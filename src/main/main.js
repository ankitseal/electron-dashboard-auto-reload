// Main process for Electron auto-reload app
// Mirrors Python behavior: set SESSION cookie before navigation, inject keep-alive, periodic reload

const { app, BrowserWindow, session, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const urlLib = require('url');
const crypto = require('crypto');

// Defaults (overridable by config.json)
const DEFAULTS = {
  reloadAfterSec: 300,
  waitForCss: null,
  keepAliveSec: 0
};

function loadConfig() {
  // Resolve known config locations
  const projectRoot = path.resolve(__dirname, '..', '..');
  const rootCfgPath = path.join(projectRoot, 'config.json');
  const srcCfgPath = path.join(path.resolve(__dirname, '..'), 'config.json');
  const packagedCfgPath = (process.resourcesPath
    ? path.join(process.resourcesPath, 'config.json')
    : null);
  // userData path is available after app is ready; guard just in case
  let userDataCfgPath = null;
  try {
    if (app && app.getPath) {
      userDataCfgPath = path.join(app.getPath('userData'), 'config.json');
    }
  } catch {}
  let cfg = {};
  // Merge in order of increasing priority:
  // packaged -> root -> src -> userData (highest)
  if (packagedCfgPath && fs.existsSync(packagedCfgPath)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(packagedCfgPath, 'utf-8')) }; } catch {}
  }
  if (fs.existsSync(rootCfgPath)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(rootCfgPath, 'utf-8')) }; } catch {}
  }
  if (fs.existsSync(srcCfgPath)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(srcCfgPath, 'utf-8')) }; } catch {}
  }
  if (userDataCfgPath && fs.existsSync(userDataCfgPath)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(userDataCfgPath, 'utf-8')) }; } catch {}
  }

  let rawUrl = typeof cfg.url === 'string' ? cfg.url : '';
  let targetUrl = rawUrl ? rawUrl.trim() : '';
  const sessionVal = cfg.session || '';
  // Decrypt credentials if present
  const getKeyPath = () => {
    try { return path.join(app.getPath('userData'), 'key.bin'); } catch { return null; }
  };
  const ensureKey = () => {
    const kp = getKeyPath();
    if (!kp) return null;
    try {
      if (!fs.existsSync(kp)) {
        fs.mkdirSync(path.dirname(kp), { recursive: true });
        const key = crypto.randomBytes(32);
        fs.writeFileSync(kp, key);
        return key;
      }
      return fs.readFileSync(kp);
    } catch { return null; }
  };
  const decryptJson = (enc) => {
    try {
      if (!enc || !enc.data || !enc.iv || !enc.tag) return null;
      const key = ensureKey();
      if (!key) return null;
      const iv = Buffer.from(enc.iv, 'base64');
      const tag = Buffer.from(enc.tag, 'base64');
      const data = Buffer.from(enc.data, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const out = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(out.toString('utf8'));
    } catch { return null; }
  };
  let user = cfg.user || { email: '', password: '' };
  if (cfg.userEnc && typeof cfg.userEnc === 'object') {
    const dec = decryptJson(cfg.userEnc);
    if (dec && dec.email) user = dec;
  }
  const hasUrl = !!targetUrl;

  // Normalize URL to include scheme/host. If missing scheme, prefix https://
  function normalize(u) {
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u);
    if (!hasScheme) {
      if (u.startsWith('//')) u = 'https:' + u; else u = 'https://' + u;
    }
    return new urlLib.URL(u).toString();
  }
  targetUrl = hasUrl ? normalize(targetUrl) : 'about:blank';

  const parsed = new urlLib.URL(targetUrl);
  const host = parsed.hostname; // exclude port
  const parts = host.split('.');
  const parentDomain = parts.length >= 3 ? parts.slice(-3).join('.') : host;

  // Rolling time window settings (backward compatible)
  const timeWindow = (cfg.timeWindow && typeof cfg.timeWindow === 'object') ? cfg.timeWindow : {};
  const useRolling = Boolean(timeWindow.enabled || cfg.useRollingWindow);
  const startHM = (timeWindow.start || cfg.windowStart || '05:30');
  const durationStr = (timeWindow.duration || '1d');

  // Auto-reload enabled flag (defaults to reloadAfterSec > 0)
  let autoReloadEnabled = (cfg.autoReloadEnabled !== undefined)
    ? !!cfg.autoReloadEnabled
    : ((cfg.reloadAfterSec ?? DEFAULTS.reloadAfterSec) > 0);

  // Safe numeric coercion that preserves 0 values (declare before first use)
  const toNumber = (val, defVal) => {
    const n = typeof val === 'string' ? Number(val) : (typeof val === 'number' ? val : NaN);
    return Number.isFinite(n) ? n : defVal;
  };

  // Navigate-back and tab timeout (child windows)
  let navigateBackEnabled = (cfg.navigateBackEnabled !== undefined) ? !!cfg.navigateBackEnabled : true;
  const tabTimeoutSec = toNumber(cfg.tabTimeoutSec ?? 600, 600); // default 10 min; 0 disables
  if (!tabTimeoutSec || tabTimeoutSec <= 0) {
    navigateBackEnabled = false; // disable navigate-back when timeout is 0
  }

  // If URL is missing, force-disable behaviors that require a target
  if (!hasUrl) {
    autoReloadEnabled = false;
    navigateBackEnabled = false;
  }

  // Determine a writable config path to persist to:
  // Prefer existing userData file, else create in userData when packaged,
  // otherwise use root config in dev.
  let usedCfgPath = userDataCfgPath && fs.existsSync(userDataCfgPath)
    ? userDataCfgPath
    : null;
  if (!usedCfgPath) {
    // If running from packaged resources, write to userData
    if (packagedCfgPath && fs.existsSync(packagedCfgPath)) {
      usedCfgPath = userDataCfgPath || rootCfgPath; // fallback to root if userData missing (dev)
    } else if (fs.existsSync(rootCfgPath)) {
      usedCfgPath = rootCfgPath;
    } else if (fs.existsSync(srcCfgPath)) {
      usedCfgPath = srcCfgPath;
    } else {
      usedCfgPath = userDataCfgPath || rootCfgPath;
    }
  }

  return {
  hasUrl,
  rawUrl,
    targetUrl,
    host,
    parentDomain,
    sessionVal,
    user,
  timeWindow: { enabled: useRolling, start: startHM, duration: durationStr },
  keepAliveSec: hasUrl ? toNumber(cfg.keepAliveSec ?? DEFAULTS.keepAliveSec, DEFAULTS.keepAliveSec) : 0,
  reloadAfterSec: hasUrl ? toNumber(cfg.reloadAfterSec ?? DEFAULTS.reloadAfterSec, DEFAULTS.reloadAfterSec) : 0,
    autoReloadEnabled,
  navigateBackEnabled,
  tabTimeoutSec,
    waitForCss: cfg.waitForCss ?? DEFAULTS.waitForCss,
    configPath: usedCfgPath
  };
}

/**
 * Set the SESSION cookie before first navigation on a fresh partition.
 */
async function setSessionCookie(electronSession, targetUrl, parentDomain, sessionVal) {
  // Clear cookies for a clean start
  try {
    await electronSession.clearStorageData({ storages: ['cookies'] });
  } catch {}

  const target = new urlLib.URL(targetUrl);
  const origin = target.origin;
  const hostname = target.hostname;
  const parts = hostname.split('.');
  const etld1 = parts.length >= 2 ? parts.slice(-2).join('.') : hostname;

  // Try several scopes
  const attempts = [
    { url: origin },                                 // host-scoped
    { domain: hostname },                            // exact host
    { domain: '.' + hostname },                      // exact host (subdomains)
    { domain: parentDomain },                        // parentDomain from config (likely 3 labels)
    { domain: '.' + parentDomain },                  // parent with leading dot
    { domain: etld1 },                               // eTLD+1
    { domain: '.' + etld1 }                          // eTLD+1 with dot
  ];

  let setOk = false;
  for (const scope of attempts) {
    try {
      const base = {
        name: 'SESSION',
        value: sessionVal,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax'
      };
      await electronSession.cookies.set({ ...base, ...scope });

      // Verify cookie visible for target origin
      const cookies = await electronSession.cookies.get({ url: origin, name: 'SESSION' });
      if (cookies && cookies.length > 0) { setOk = true; break; }
    } catch (e) {
      // continue trying next scope
    }
  }

  if (!setOk) {
    throw new Error('Failed to set SESSION cookie before navigation.');
  }
}

async function bootstrap() {
  // Ensure app paths (like userData) are available
  await app.whenReady();

  const cfg = loadConfig();

  // Create a unique in-memory session partition (incognito-like) and set cookie before nav
  const partitionName = 'autorld_' + Date.now(); // non-persistent when missing 'persist:'
  const sess = session.fromPartition(partitionName);

  if (cfg.sessionVal) {
    await setSessionCookie(sess, cfg.targetUrl, cfg.parentDomain, cfg.sessionVal);
  }

  const win = new BrowserWindow({
    show: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
  icon: path.join(__dirname, '..', '..', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.once('ready-to-show', () => win.show());

  // Provide config to preload/renderer
  ipcMain.handle('get-config', () => ({
    // Raw config for settings UI
  url: cfg.hasUrl ? cfg.targetUrl : '',
    session: cfg.sessionVal,
    timeWindow: cfg.timeWindow,
    // Fields used by preload
    targetUrl: cfg.targetUrl,
    reloadAfterSec: cfg.reloadAfterSec,
    waitForCss: cfg.waitForCss,
  keepAliveSec: cfg.keepAliveSec,
    user: cfg.user,
  autoReloadEnabled: cfg.autoReloadEnabled,
  navigateBackEnabled: cfg.navigateBackEnabled,
  tabTimeoutSec: cfg.tabTimeoutSec
  }));

  // Persist config updates and apply them
  ipcMain.handle('save-config', async (_evt, newCfg) => {
    try {
      if (!newCfg || typeof newCfg !== 'object') throw new Error('Invalid config');

  // Determine writable target path: always prefer userData for persistence
  let targetPath = null;
  try { targetPath = path.join(app.getPath('userData'), 'config.json'); } catch {}
  if (!targetPath) targetPath = cfg.configPath;

      // Merge and normalize
      // Determine auto-reload enabled state and coerce reloadAfterSec
      let desiredReload = Number.isFinite(newCfg.reloadAfterSec) ? Number(newCfg.reloadAfterSec) : cfg.reloadAfterSec;
      let autoEnabled = (newCfg.autoReloadEnabled !== undefined) ? !!newCfg.autoReloadEnabled : cfg.autoReloadEnabled;
      if (desiredReload === 0) autoEnabled = false; // auto-off when interval is 0
      if (autoEnabled && (!Number.isFinite(desiredReload) || desiredReload <= 0)) desiredReload = 250; // require > 0

      // Determine navigate-back and tab timeout linkage
      const desiredTabTimeout = Number.isFinite(newCfg.tabTimeoutSec) ? Number(newCfg.tabTimeoutSec) : cfg.tabTimeoutSec;
      let navBack = (newCfg.navigateBackEnabled !== undefined) ? !!newCfg.navigateBackEnabled : cfg.navigateBackEnabled;
      if (!Number.isFinite(desiredTabTimeout) || desiredTabTimeout <= 0) navBack = false;

      const merged = {
        url: (typeof newCfg.url === 'string') ? newCfg.url : (cfg.hasUrl ? cfg.targetUrl : ''),
        session: newCfg.session || cfg.sessionVal || '',
        keepAliveSec: Number.isFinite(newCfg.keepAliveSec) ? Number(newCfg.keepAliveSec) : cfg.keepAliveSec,
        reloadAfterSec: desiredReload,
        waitForCss: newCfg.waitForCss ?? cfg.waitForCss ?? null,
        user: newCfg.user || cfg.user || { email: '', password: '' },
        timeWindow: newCfg.timeWindow || cfg.timeWindow || { enabled: false, start: '05:30' },
        autoReloadEnabled: autoEnabled,
        navigateBackEnabled: navBack,
        tabTimeoutSec: Number.isFinite(desiredTabTimeout) ? desiredTabTimeout : 600
      };

  // Write file (ensure folder exists)
      // Encrypt credentials before writing
      const encryptJson = (obj) => {
        try {
          const keyPath = path.join(app.getPath('userData'), 'key.bin');
          let key = null;
          try { key = fs.readFileSync(keyPath); } catch {
            fs.mkdirSync(path.dirname(keyPath), { recursive: true });
            key = crypto.randomBytes(32);
            fs.writeFileSync(keyPath, key);
          }
          const iv = crypto.randomBytes(12);
          const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
          const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
          const tag = cipher.getAuthTag();
          return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
        } catch { return null; }
      };

      const toWrite = { ...merged };
      if (toWrite.user && (toWrite.user.email || toWrite.user.password)) {
        const enc = encryptJson(toWrite.user);
        if (enc) {
          toWrite.userEnc = enc;
          delete toWrite.user; // do not persist plaintext
        }
      } else {
        delete toWrite.user; // avoid empty structure
      }

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(toWrite, null, 2));

      // Apply in-memory cfg (mutate properties)
  cfg.hasUrl = !!(merged.url && String(merged.url).trim());
  cfg.targetUrl = cfg.hasUrl ? (String(merged.url).match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/) ? merged.url : ('https://' + merged.url)) : 'about:blank';
  cfg.sessionVal = merged.session;
  cfg.keepAliveSec = cfg.hasUrl ? merged.keepAliveSec : 0;
  cfg.reloadAfterSec = cfg.hasUrl ? merged.reloadAfterSec : 0;
  cfg.waitForCss = merged.waitForCss;
  cfg.user = merged.user; // in-memory keeps plaintext
  cfg.timeWindow = merged.timeWindow;
  cfg.autoReloadEnabled = cfg.hasUrl ? merged.autoReloadEnabled : false;
  cfg.navigateBackEnabled = cfg.hasUrl ? merged.navigateBackEnabled : false;
  cfg.tabTimeoutSec = merged.tabTimeoutSec;

      // Update target base for watchdog
      targetBase = cfg.hasUrl ? stripFromTo(cfg.targetUrl) : 'about:blank';

      // Reload target with possibly updated rolling window
      const winRange = computeWindow(cfg.timeWindow.start);
      const dest = cfg.hasUrl
        ? (cfg.timeWindow.enabled ? withWindowParams(cfg.targetUrl, winRange) : cfg.targetUrl)
        : 'about:blank';
      console.log('[electron-auto-reload] Applying new config, navigating to:', dest);
      win.loadURL(dest).catch(() => {});

  return { ok: true, path: targetPath };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // Child window management for links intended to open in new tabs
  const childWindows = new Set();
  const childMeta = new Map(); // BrowserWindow -> { createdAt, lastActive }
  function createChildWindow(openUrl) {
    const child = new BrowserWindow({
      parent: win,
      modal: false,
      show: true,
      autoHideMenuBar: true,
      fullscreen: true,
      backgroundColor: '#000000',
  icon: path.join(__dirname, '..', '..', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        partition: partitionName,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    // Track active time
    const meta = { createdAt: Date.now(), lastActive: Date.now() };
    childWindows.add(child);
    childMeta.set(child, meta);
    child.on('focus', () => { meta.lastActive = Date.now(); });
    child.on('show', () => { meta.lastActive = Date.now(); });
    child.on('closed', () => { childWindows.delete(child); childMeta.delete(child); });
    try { child.loadURL(openUrl); } catch {}
    return child;
  }

  // Intercept window.open and open as child window
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { createChildWindow(url); } catch {}
    return { action: 'deny' };
  });

  // Convert duration label to milliseconds
  function durationToMs(label) {
    const map = {
      '1h': 1 * 60 * 60 * 1000,
      '2h': 2 * 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '12h': 12 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
      '2d': 2 * 24 * 60 * 60 * 1000,
      '5d': 5 * 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
    };
    if (typeof label === 'string' && map[label]) return map[label];
    // fallback: try number of hours in string
    const h = parseInt(String(label||'').replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(h) && h > 0) return h * 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000; // default 1d
  }

  // Compute rolling window anchored at the daily start time.
  // "Daily start" is the from time; "Duration" dictates the to time.
  // If the current time is past today's (from + duration), roll to the next day.
  function computeWindow(startHM) {
    const [hStr, mStr] = String(startHM || '05:30').split(':');
    const sh = Math.max(0, Math.min(23, parseInt(hStr || '5', 10) || 0));
    const sm = Math.max(0, Math.min(59, parseInt(mStr || '30', 10) || 0));
    const now = new Date();
    const durMs = durationToMs(cfg.timeWindow?.duration || '1d');
    const dayMs = 24 * 60 * 60 * 1000;

    // Start with today or yesterday depending on current time vs start
    let from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0, 0);
    if (now < from) {
      from = new Date(from.getTime() - dayMs);
    }
    let to = new Date(from.getTime() + durMs);

    // If we've passed the end of today's window, roll forward by whole days
    while (now >= to) {
      from = new Date(from.getTime() + dayMs);
      to = new Date(from.getTime() + durMs);
    }

    return { from: from.getTime(), to: to.getTime() };
  }

  function withWindowParams(urlStr, win) {
    try {
      // Remember if URL had a bare kiosk flag (without '=') so we can preserve it
      const hadBareKiosk = /[?&]kiosk(?:&|$)/.test(urlStr);
      const u = new urlLib.URL(urlStr);
      if (cfg.timeWindow.enabled) {
        u.searchParams.set('from', String(win.from));
        u.searchParams.set('to', String(win.to));
      }
      let out = u.toString();
      if (hadBareKiosk) {
        // Convert kiosk= back to kiosk (no value)
        out = out.replace(/([?&])kiosk=(?=&|$)/g, '$1kiosk');
      }
      return out;
    } catch {
      return urlStr;
    }
  }

  function stripFromTo(urlStr) {
    try {
      const u = new urlLib.URL(urlStr);
      u.searchParams.delete('from');
      u.searchParams.delete('to');
      u.hash = '';
      return u.toString();
    } catch { return urlStr; }
  }

  // Helper: check and persist SESSION cookie when on target domain
  const persistSessionIfAvailable = async () => {
    try {
      const current = win.webContents.getURL();
      const curHost = new urlLib.URL(current).hostname;
      const isTargetHost = curHost === cfg.host || curHost.endsWith('.' + cfg.parentDomain) || curHost === cfg.parentDomain;
      if (!isTargetHost) return;

      const target = new urlLib.URL(cfg.targetUrl);
      let cookieVal = '';
      // Try by url first
      const byUrl = await sess.cookies.get({ url: target.origin, name: 'SESSION' });
      if (byUrl && byUrl.length > 0) cookieVal = byUrl[0].value;
      if (!cookieVal) {
        // Try by domain variants
        const byDomain = await sess.cookies.get({ domain: target.hostname, name: 'SESSION' });
        if (byDomain && byDomain.length > 0) cookieVal = byDomain[0].value;
      }
      if (cookieVal && cookieVal !== cfg.sessionVal) {
        // Update file. If configPath points to resources (read-only), write to userData instead
        let fileCfg = {};
        try { fileCfg = JSON.parse(fs.readFileSync(cfg.configPath, 'utf-8')); } catch {}
        fileCfg.session = cookieVal;
          // Always prefer saving to userData for persistence
          let targetPath = null;
          try { targetPath = path.join(app.getPath('userData'), 'config.json'); } catch {}
          if (!targetPath) targetPath = cfg.configPath;
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, JSON.stringify(fileCfg, null, 2));
        cfg.sessionVal = cookieVal;
      }
    } catch {}
  };

  // On navigation or in-page navigation, attempt to persist new session
  win.webContents.on('did-finish-load', persistSessionIfAvailable);
  win.webContents.on('did-navigate-in-page', persistSessionIfAvailable);

  // Watchdog: every minute, ensure we're on the configured URL; if not, redirect back (if enabled)
  let targetBase = stripFromTo(cfg.targetUrl);
  const ensureTargetUrl = () => {
    try {
      const current = win.webContents.getURL();
      if (!current) return;
      const curBase = stripFromTo(current);

      // If on a different base URL (origin/path or base query), go back to the configured one (only when enabled)
      if (cfg.navigateBackEnabled && curBase !== targetBase) {
        const winRange = computeWindow(cfg.timeWindow.start);
        const dest = withWindowParams(cfg.targetUrl, winRange);
        console.log('[electron-auto-reload] Redirecting to target URL:', dest);
        win.loadURL(dest).catch(() => {});
        return;
      }

      // If rolling window is enabled, ensure from/to match desired window
      if (cfg.timeWindow.enabled) {
        const desired = computeWindow(cfg.timeWindow.start);
        const curUrl = new urlLib.URL(current);
        const curFrom = Number(curUrl.searchParams.get('from') || 0);
        const curTo = Number(curUrl.searchParams.get('to') || 0);
        const driftOk = 5000; // allow 5s tolerance
        const fromDiff = Math.abs(curFrom - desired.from);
        const toDiff = Math.abs(curTo - desired.to);
        if (!(fromDiff <= driftOk && toDiff <= driftOk)) {
          const dest = withWindowParams(cfg.targetUrl, desired);
          console.log('[electron-auto-reload] Updating rolling window URL:', dest);
          win.loadURL(dest).catch(() => {});
        }
      }
    } catch {}
  };
  const watchdogId = setInterval(ensureTargetUrl, 60 * 1000);
  win.on('closed', () => { try { clearInterval(watchdogId); } catch {} });

  // Child timeout monitor: close stale child windows and refocus main to target URL
  const childTimer = setInterval(() => {
    try {
      if (!cfg.navigateBackEnabled) return;
      if (!cfg.tabTimeoutSec || cfg.tabTimeoutSec <= 0) return;
      const now = Date.now();
      for (const child of Array.from(childWindows)) {
        const meta = childMeta.get(child);
        if (!meta) continue;
        const aliveMs = now - (child.isFocused() ? meta.lastActive : meta.createdAt);
        if (aliveMs >= cfg.tabTimeoutSec * 1000) {
          try { child.close(); } catch {}
          // Ensure main window is on the target URL
          const desired = cfg.timeWindow.enabled ? withWindowParams(cfg.targetUrl, computeWindow(cfg.timeWindow.start)) : cfg.targetUrl;
          try { win.loadURL(desired); } catch {}
          try { win.focus(); } catch {}
        }
      }
    } catch {}
  }, 10 * 1000);
  win.on('closed', () => { try { clearInterval(childTimer); } catch {} });

  // Menu with Settings and Auto-Reload controls
  const openSettings = () => {
    const settingsWin = new BrowserWindow({
      width: 700,
      height: 700,
      title: 'Settings',
      modal: false,
      parent: win,
    icon: path.join(__dirname, '..', '..', 'icon.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '..', 'preload', 'settings-preload.js')
      }
    });
    settingsWin.removeMenu();
    settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html')).catch(() => {});
  };

  // Allow renderer to request opening Settings (used by missing-settings screen)
  ipcMain.on('open-settings', () => { try { openSettings(); } catch {} });

  ipcMain.on('auto-reload-start', () => {
    try { win.webContents.send('auto-reload-start'); } catch {}
  });
  ipcMain.on('auto-reload-stop', () => {
    try { win.webContents.send('auto-reload-stop'); } catch {}
  });

  // Menu with a toggle checkbox for auto-refresh
  const menu = Menu.buildFromTemplate([
    {
      label: 'Settings',
      submenu: [
  { label: 'Open Settings…', accelerator: 'Ctrl+/', click: () => openSettings() },
        { type: 'separator' },
        {
          label: 'Auto Refresh',
          type: 'checkbox',
          checked: !!cfg.autoReloadEnabled,
          click: async (menuItem) => {
            if (!cfg.hasUrl) { menuItem.checked = false; return; }
            // Toggle
            const enable = menuItem.checked;
            let newReload = cfg.reloadAfterSec;
            if (enable && (!Number.isFinite(newReload) || newReload <= 0)) {
              newReload = 250; // default when enabling via menu
            }
            // Persist config and update in-memory
            const res = await ipcMain.invoke ? null : null; // placeholder to avoid linter
            try {
              // Write directly without going through renderer
              const targetPath = path.join(app.getPath('userData'), 'config.json');
              const fileCfg = {
                url: cfg.targetUrl,
                session: cfg.sessionVal,
                keepAliveSec: cfg.keepAliveSec,
                reloadAfterSec: enable ? newReload : 0,
                waitForCss: cfg.waitForCss,
                timeWindow: cfg.timeWindow,
                autoReloadEnabled: enable,
                navigateBackEnabled: (cfg.tabTimeoutSec && cfg.tabTimeoutSec > 0) ? cfg.navigateBackEnabled : false,
                tabTimeoutSec: (Number.isFinite(cfg.tabTimeoutSec) ? cfg.tabTimeoutSec : 600)
              };
              // Preserve encrypted credentials if available by re-encrypting current in-memory user
              if (cfg.user && (cfg.user.email || cfg.user.password)) {
                const keyPath = path.join(app.getPath('userData'), 'key.bin');
                let key = null;
                try { key = fs.readFileSync(keyPath); } catch {
                  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
                  key = crypto.randomBytes(32);
                  fs.writeFileSync(keyPath, key);
                }
                const iv = crypto.randomBytes(12);
                const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
                const data = Buffer.concat([cipher.update(JSON.stringify(cfg.user), 'utf8'), cipher.final()]);
                const tag = cipher.getAuthTag();
                fileCfg.userEnc = { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
              }
              fs.mkdirSync(path.dirname(targetPath), { recursive: true });
              fs.writeFileSync(targetPath, JSON.stringify(fileCfg, null, 2));
            } catch {}

            cfg.autoReloadEnabled = enable;
            cfg.reloadAfterSec = enable ? newReload : 0;
            if (enable) {
              win.webContents.send('auto-reload-start');
            } else {
              win.webContents.send('auto-reload-stop');
            }
          }
  }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Quit', role: 'quit' }
  ]);
  Menu.setApplicationMenu(menu);

  try {
    if (cfg.hasUrl) {
      const initialUrl = cfg.timeWindow.enabled
        ? withWindowParams(cfg.targetUrl, computeWindow(cfg.timeWindow.start))
        : cfg.targetUrl;
      console.log('[electron-auto-reload] Final URL:', initialUrl);
      await win.loadURL(initialUrl);
    } else {
      console.log('[electron-auto-reload] No URL configured — showing missing-settings screen and opening Settings…');
      const missingPath = path.join(__dirname, '..', 'renderer', 'missing.html');
      await win.loadFile(missingPath).catch(async () => { await win.loadURL('about:blank'); });
      setTimeout(() => { try { openSettings(); } catch {} }, 400);
    }
  } catch (e) {
    // Ignore initial redirect aborts
    if (!(e && e.code === 'ERR_ABORTED')) {
      throw e;
    }
  }
}

app.on('window-all-closed', () => {
  app.quit();
});

app.whenReady().then(bootstrap).catch(err => {
  console.error('Failed to start:', err);
  app.quit();
});
