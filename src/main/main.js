// Main process for Electron auto-reload app
// Mirrors Python behavior: set SESSION cookie before navigation, inject keep-alive, periodic reload

const { app, BrowserWindow, session, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const urlLib = require('url');
const crypto = require('crypto');
const { URL } = urlLib;
const dgram = require('dgram'); // For lightweight NTP query

// --- Lightweight NTP time (used for TOTP) ----------------------------------
// We keep an offset (ntpTime - systemTime). If NTP fails, offset stays 0 and we
// transparently fall back to system time (previous behavior).
let ntpOffsetMs = 0;
let lastNtpSync = 0;
let ntpSyncInFlight = false;
let configuredNtpServers = [];
let useSystemTimePreference = false;

function splitProxyHost(raw) {
  if (!raw) return { host: '', port: null };
  let str = String(raw).trim();
  str = str.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  str = str.split('/')[0];
  if (str.startsWith('[')) {
    const end = str.indexOf(']');
    if (end !== -1) {
      const host = str.slice(0, end + 1);
      const remainder = str.slice(end + 1);
      if (remainder.startsWith(':')) {
        const candidate = remainder.slice(1);
        if (/^[0-9]+$/.test(candidate)) {
          return { host, port: Number(candidate) };
        }
      }
      return { host, port: null };
    }
  } else {
    const colonIndex = str.lastIndexOf(':');
    if (colonIndex > -1) {
      const candidate = str.slice(colonIndex + 1);
      if (/^[0-9]+$/.test(candidate)) {
        return { host: str.slice(0, colonIndex), port: Number(candidate) };
      }
    }
  }
  return { host: str, port: null };
}

function sanitizeProxyHost(raw) {
  return splitProxyHost(raw).host;
}

function parseNtpServers(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function applyNtpPreferences(serverValue, useLocalTime) {
  const parsed = parseNtpServers(serverValue);
  configuredNtpServers = parsed;
  useSystemTimePreference = !!useLocalTime || parsed.length === 0;
  syncNtpTime(true);
}

function syncNtpTime(force = false) {
  if (useSystemTimePreference) {
    ntpOffsetMs = 0;
    lastNtpSync = Date.now();
    ntpSyncInFlight = false;
    return;
  }
  if (ntpSyncInFlight) return;
  const now = Date.now();
  if (!force && (now - lastNtpSync) < 5 * 60 * 1000) return; // 5 min cache
  ntpSyncInFlight = true;
  if (!configuredNtpServers.length) {
    ntpSyncInFlight = false;
    ntpOffsetMs = 0;
    lastNtpSync = Date.now();
    return;
  }
  const server = configuredNtpServers[(Math.random() * configuredNtpServers.length) | 0];
  if (!server) {
    ntpSyncInFlight = false;
    return;
  }
  try {
    const socket = dgram.createSocket('udp4');
    const msg = Buffer.alloc(48);
    // LI=0 (no warning), VN=4, Mode=3 (client)
    msg[0] = 0x1B; // 00 011 011
    const timeout = setTimeout(() => {
      try { socket.close(); } catch {}
      ntpSyncInFlight = false; // timeout -> fallback remains
    }, 1500);
    socket.once('error', () => {
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      ntpSyncInFlight = false;
    });
    socket.once('message', (buf) => {
      clearTimeout(timeout);
      try {
        if (buf.length >= 48) {
          const secs = buf.readUInt32BE(40); // Transmit Timestamp seconds
          const frac = buf.readUInt32BE(44); // Transmit Timestamp fraction
          // Convert NTP (since 1900) to Unix epoch (since 1970)
          const NTP_UNIX_DELTA = 2208988800; // seconds
          const ms = (secs - NTP_UNIX_DELTA) * 1000 + Math.round((frac / 2 ** 32) * 1000);
          ntpOffsetMs = ms - Date.now();
          lastNtpSync = Date.now();
        }
      } catch {}
      try { socket.close(); } catch {}
      ntpSyncInFlight = false;
    });
    socket.send(msg, 123, server, () => { /* sent */ });
  } catch {
    ntpSyncInFlight = false; // ignore
  }
}

// Kick off an initial (non-blocking) sync; later periodic resync.
setTimeout(() => syncNtpTime(true), 2000); // slight delay until network ready
setInterval(() => syncNtpTime(false), 15 * 60 * 1000).unref(); // periodic

function currentTimeMsForTOTP() {
  // If no sync yet (offset 0) this is identical to previous behavior
  return Date.now() + ntpOffsetMs;
}

// Defaults (overridable by config.json)
const DEFAULTS = {
  reloadAfterSec: 300,
  waitForCss: null,
  keepAliveSec: 0,
  ntpServer: '',
  useSystemTime: false,
  proxyHost: '',
  proxyPort: 0,
  proxyUseHttps: true,
  proxyEnabled: false
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

  const configuredNtpServer = (typeof cfg.ntpServer === 'string')
    ? cfg.ntpServer.trim()
    : DEFAULTS.ntpServer;
  const useSystemTime = (cfg.useSystemTime === undefined)
    ? DEFAULTS.useSystemTime
    : !!cfg.useSystemTime;
  const { host: parsedProxyHost, port: inlineProxyPort } = splitProxyHost(cfg.proxyHost);
  const { host: parsedLegacyHttpsHost, port: inlineLegacyHttpsPort } = splitProxyHost(cfg.proxyHttpsHost);
  let proxyHost = parsedProxyHost || DEFAULTS.proxyHost;
  let proxyPort = Number.isFinite(Number(cfg.proxyPort)) ? Number(cfg.proxyPort) : (inlineProxyPort ?? DEFAULTS.proxyPort);
  const legacyHttpsHost = parsedLegacyHttpsHost;
  const legacyHttpsPort = Number.isFinite(Number(cfg.proxyHttpsPort)) ? Number(cfg.proxyHttpsPort) : (inlineLegacyHttpsPort ?? 0);
  let proxyUseHttps = (cfg.proxyUseHttps === undefined)
    ? DEFAULTS.proxyUseHttps
    : !!cfg.proxyUseHttps;

  if (!proxyUseHttps && (legacyHttpsHost || legacyHttpsPort > 0)) {
    if (!proxyHost && legacyHttpsHost) proxyHost = legacyHttpsHost;
    if ((!Number.isFinite(proxyPort) || proxyPort <= 0) && legacyHttpsPort > 0) {
      proxyPort = legacyHttpsPort;
    }
    proxyUseHttps = true;
  }

  proxyPort = Number.isFinite(proxyPort) ? proxyPort : 0;
  const proxyEnabledRaw = (cfg.proxyEnabled === undefined) ? DEFAULTS.proxyEnabled : !!cfg.proxyEnabled;
  const proxyEnabled = proxyEnabledRaw && (proxyHost && proxyPort > 0);

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
      ntpServer: configuredNtpServer,
      useSystemTime,
    proxyHost,
    proxyPort,
  proxyUseHttps,
    proxyEnabled,
    waitForCss: cfg.waitForCss ?? DEFAULTS.waitForCss,
  configPath: usedCfgPath,
  // 2FA persisted state: enabled flag and encrypted secret (if present)
  twoFAEnabled: !!cfg.twoFAEnabled,
  twoFAEnc: cfg.twoFAEnc
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
  applyNtpPreferences(cfg.ntpServer, cfg.useSystemTime);

  // 2FA state (enabled flag persisted; secret persisted encrypted like credentials)
  let twoFAEnabled = !!cfg.twoFAEnabled;
  let twoFASecret = '';
  // If config loaded an encrypted secret, decrypt it here similar to userEnc
  const decryptJson = (enc) => {
    try {
      if (!enc || !enc.data || !enc.iv || !enc.tag) return null;
      const keyPath = path.join(app.getPath('userData'), 'key.bin');
      const key = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
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
  try {
    if (cfg.twoFAEnc && typeof cfg.twoFAEnc === 'object') {
      const dec = decryptJson(cfg.twoFAEnc);
      if (dec && dec.secret) twoFASecret = String(dec.secret || '').trim();
    }
  } catch {}
  // Extract base32 secret from raw input (accepts otpauth:// or plain base32)
  function extractBase32Secret(input) {
    if (!input) return '';
    const raw = String(input).trim();
    try {
      if (raw.toLowerCase().startsWith('otpauth://')) {
        const u = new URL(raw);
        const secret = u.searchParams.get('secret') || '';
        return secret.replace(/\s+/g, '').toUpperCase();
      }
    } catch {}
    return raw.replace(/\s+/g, '').toUpperCase();
  }
  // Base32 decode (RFC 4648) without padding strictly needed
  function base32ToBytes(b32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = (b32 || '').toUpperCase().replace(/=+$/,'');
    let bits = '';
    for (const ch of clean) {
      const idx = alphabet.indexOf(ch);
      if (idx === -1) continue;
      bits += idx.toString(2).padStart(5,'0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i+8), 2));
    }
    return Buffer.from(bytes);
  }
  function generateTOTP(secretB32, timeStep = 30, digits = 6) {
    const key = base32ToBytes(secretB32);
    if (!key || key.length === 0) return '';
  const counter = Math.floor(currentTimeMsForTOTP() / 1000 / timeStep);
    const buf = Buffer.alloc(8);
    // big-endian counter
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const codeInt = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
    const code = (codeInt % (10 ** digits)).toString().padStart(digits, '0');
    return code;
  }

  // Resolve app icon (moved to /image/icon.ico). Prefer packaged resources, then dev path.
  const resolveIcon = () => {
    try {
      const resRoot = process.resourcesPath;
      if (resRoot) {
        // New location inside resources/image
        const pImg = path.join(resRoot, 'image', 'icon.ico');
        if (fs.existsSync(pImg)) return pImg;
        // Backward-compat fallback if icon was copied to resources root
        const pRoot = path.join(resRoot, 'icon.ico');
        if (fs.existsSync(pRoot)) return pRoot;
      }
    } catch {}
    // Dev fallback to repo /image folder, then legacy root
    const devImg = path.join(__dirname, '..', '..', 'image', 'icon.ico');
    if (fs.existsSync(devImg)) return devImg;
    const devRoot = path.join(__dirname, '..', '..', 'icon.ico');
    return devRoot;
  };
  const appIcon = resolveIcon();

  // Create a unique in-memory session partition (incognito-like) and set cookie before nav
  const partitionName = 'autorld_' + Date.now(); // non-persistent when missing 'persist:'
  const sess = session.fromPartition(partitionName);

  if (cfg.sessionVal) {
    await setSessionCookie(sess, cfg.targetUrl, cfg.parentDomain, cfg.sessionVal);
  }

  async function configureProxy(proxyHost, proxyPort, useHttps, enabled) {
    const { host: cleanHost, port: inlinePort } = splitProxyHost(proxyHost);
    const providedPort = Number.isFinite(Number(proxyPort)) ? Number(proxyPort) : (inlinePort ?? 0);
    const portNum = Number.isInteger(providedPort) ? providedPort : Math.floor(providedPort);
    const allow = !!enabled && !!cleanHost && Number.isInteger(portNum) && portNum > 0;
    const rules = [];
    if (allow) {
      rules.push(`http=${cleanHost}:${portNum}`);
      if (useHttps) {
        rules.push(`https=${cleanHost}:${portNum}`);
      }
    }
    const proxyRules = rules.length ? rules.join(';') : 'direct://';
    try {
  await sess.setProxy({ proxyRules, proxyBypassRules: 'localhost,127.0.0.1,::1' });
    } catch (err) {
      console.error('[electron-auto-reload] Failed to apply proxy settings:', err);
    }
  }
  await configureProxy(cfg.proxyHost, cfg.proxyPort, cfg.proxyUseHttps, cfg.proxyEnabled);

  const win = new BrowserWindow({
    show: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: app.getName && typeof app.getName === 'function' ? app.getName() : 'Dashboard Auto Reload',
    fullscreenWindowTitle: app.getName && typeof app.getName === 'function' ? app.getName() : 'Dashboard Auto Reload',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      enableRemoteModule: false
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
  ntpServer: cfg.ntpServer,
  useSystemTime: cfg.useSystemTime,
  proxyHost: cfg.proxyHost,
  proxyPort: cfg.proxyPort,
  proxyUseHttps: cfg.proxyUseHttps,
  proxyEnabled: cfg.proxyEnabled,
  autoReloadEnabled: cfg.autoReloadEnabled,
  navigateBackEnabled: cfg.navigateBackEnabled,
  tabTimeoutSec: cfg.tabTimeoutSec
  }));

  // 2FA IPC: manage enabled flag (persisted) and secret (memory-only)
  ipcMain.handle('get-2fa-state', () => ({ enabled: twoFAEnabled, hasSecret: !!twoFASecret }));
  ipcMain.handle('set-2fa-enabled', async (_e, enabled) => {
    twoFAEnabled = !!enabled;
    // Write only the flag into persisted config file
    try {
      let fileCfg = {};
      try { fileCfg = JSON.parse(fs.readFileSync(cfg.configPath, 'utf-8')); } catch {}
      fileCfg.twoFAEnabled = twoFAEnabled;
      const targetPath = path.join(app.getPath('userData'), 'config.json');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(fileCfg, null, 2));
    } catch {}
    return { ok: true };
  });
  ipcMain.handle('set-2fa-secret', async (_e, secretRaw) => {
    twoFASecret = extractBase32Secret(secretRaw || '');
    // Persist encrypted secret alongside other settings
    try {
      let fileCfg = {};
      try { fileCfg = JSON.parse(fs.readFileSync(cfg.configPath, 'utf-8')); } catch {}
      const keyPath = path.join(app.getPath('userData'), 'key.bin');
      let key = null;
      try { key = fs.readFileSync(keyPath); } catch {
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        key = crypto.randomBytes(32);
        fs.writeFileSync(keyPath, key);
      }
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify({ secret: twoFASecret }), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      fileCfg.twoFAEnc = { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
      const targetPath = path.join(app.getPath('userData'), 'config.json');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(fileCfg, null, 2));
    } catch {}
    return { ok: true };
  });
  ipcMain.handle('get-totp-code', async () => {
    if (!twoFAEnabled || !twoFASecret) return '';
    try { return generateTOTP(twoFASecret); } catch { return ''; }
  });
  // Optional: expose NTP sync status (not used yet by UI)
  ipcMain.handle('get-ntp-status', () => ({
    offsetMs: ntpOffsetMs,
    lastSync: lastNtpSync,
    usingSystemTime: useSystemTimePreference
  }));
  ipcMain.handle('set-ntp-preference', async (_event, payload) => {
    try {
      const server = payload && Object.prototype.hasOwnProperty.call(payload, 'server') ? payload.server : cfg.ntpServer;
      const useLocal = payload && Object.prototype.hasOwnProperty.call(payload, 'useSystemTime') ? !!payload.useSystemTime : cfg.useSystemTime;
      applyNtpPreferences(server, useLocal);
      if (Array.isArray(server)) {
        cfg.ntpServer = server.map((val) => String(val || '').trim()).filter(Boolean).join(', ');
      } else if (typeof server === 'string') {
        cfg.ntpServer = server.trim();
      }
      const parsedServers = parseNtpServers(server);
      cfg.useSystemTime = useLocal || parsedServers.length === 0;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('set-proxy-preference', async (_event, payload) => {
    try {
      const hostRaw = (payload && typeof payload.host === 'string') ? payload.host : (cfg.proxyHost || '');
      const parsedHost = splitProxyHost(hostRaw);
      const cleanHost = parsedHost.host;
      const portRaw = payload && Object.prototype.hasOwnProperty.call(payload, 'port') ? Number(payload.port) : Number(cfg.proxyPort);
      let port = Number.isFinite(portRaw) ? Math.max(0, Math.floor(portRaw)) : 0;
      if ((!port || port <= 0) && Number.isFinite(parsedHost.port) && parsedHost.port > 0) {
        port = parsedHost.port;
      }
      const useHttpsRaw = payload && Object.prototype.hasOwnProperty.call(payload, 'useHttps') ? payload.useHttps : cfg.proxyUseHttps;
      const enabled = !!(payload && Object.prototype.hasOwnProperty.call(payload, 'enabled') ? payload.enabled : cfg.proxyEnabled);
      cfg.proxyHost = cleanHost;
      cfg.proxyPort = port;
    cfg.proxyUseHttps = !!useHttpsRaw;
    cfg.proxyEnabled = !!enabled && (cleanHost && port > 0);
  await configureProxy(cfg.proxyHost, cfg.proxyPort, cfg.proxyUseHttps, cfg.proxyEnabled);
  return { ok: true, enabled: cfg.proxyEnabled, useHttps: cfg.proxyUseHttps };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });
  ipcMain.handle('remove-2fa-secret', async () => {
    twoFASecret = '';
    try {
      let fileCfg = {};
      try { fileCfg = JSON.parse(fs.readFileSync(cfg.configPath, 'utf-8')); } catch {}
      delete fileCfg.twoFAEnc;
      const targetPath = path.join(app.getPath('userData'), 'config.json');
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(fileCfg, null, 2));
    } catch {}
    return { ok: true };
  });

  // App version for Settings UI
  ipcMain.handle('get-version', () => ({ version: app.getVersion() }));

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

      // Enforce: when rolling window is enabled, reload interval must be < duration
      const nextTW = newCfg.timeWindow || cfg.timeWindow || { enabled: false, start: '05:30', duration: '1d' };
      if (autoEnabled && nextTW.enabled) {
        const map = { '1h':3600,'2h':7200,'6h':21600,'12h':43200,'1d':86400,'2d':172800,'5d':432000,'7d':604800 };
        const durSec = map[nextTW.duration] ?? (() => { const h = parseInt(String(nextTW.duration||'').replace(/[^0-9]/g,''),10); return Number.isFinite(h)&&h>0 ? h*3600 : 86400; })();
        if (Number.isFinite(desiredReload) && desiredReload >= durSec) {
          // Coerce to dur-1 to keep timer functional while respecting constraint
          desiredReload = Math.max(1, durSec - 1);
        }
      }

      // Determine navigate-back and tab timeout linkage
      const desiredTabTimeout = Number.isFinite(newCfg.tabTimeoutSec) ? Number(newCfg.tabTimeoutSec) : cfg.tabTimeoutSec;
      let navBack = (newCfg.navigateBackEnabled !== undefined) ? !!newCfg.navigateBackEnabled : cfg.navigateBackEnabled;
      if (!Number.isFinite(desiredTabTimeout) || desiredTabTimeout <= 0) navBack = false;

      let nextNtpServer = cfg.ntpServer || '';
      if (newCfg.ntpServer !== undefined) {
        if (Array.isArray(newCfg.ntpServer)) {
          const cleaned = newCfg.ntpServer.map((val) => String(val || '').trim()).filter(Boolean);
          nextNtpServer = cleaned.join(', ');
        } else if (typeof newCfg.ntpServer === 'string') {
          const trimmed = newCfg.ntpServer.trim();
          nextNtpServer = trimmed;
        }
      }
  const nextUseSystem = (newCfg.useSystemTime !== undefined)
    ? !!newCfg.useSystemTime
    : !!cfg.useSystemTime;
      const requestedProxyHost = (newCfg.proxyHost !== undefined) ? newCfg.proxyHost : cfg.proxyHost;
      const parsedNextProxy = splitProxyHost(requestedProxyHost);
      const nextProxyHost = parsedNextProxy.host || '';
      let nextProxyPort = (() => {
        const candidate = Number(newCfg.proxyPort);
        if (Number.isFinite(candidate)) return candidate;
        if (Number.isFinite(parsedNextProxy.port)) return parsedNextProxy.port;
        const existing = Number(cfg.proxyPort);
        return Number.isFinite(existing) ? existing : 0;
      })();
      if (!Number.isInteger(nextProxyPort) || nextProxyPort < 0) {
        nextProxyPort = 0;
      }
      const nextProxyUseHttps = (newCfg.proxyUseHttps !== undefined)
        ? !!newCfg.proxyUseHttps
        : !!cfg.proxyUseHttps;
      const nextProxyEnabled = !!newCfg.proxyEnabled && (
        nextProxyHost && nextProxyPort > 0
      );

  const merged = {
        url: (typeof newCfg.url === 'string') ? newCfg.url : (cfg.hasUrl ? cfg.targetUrl : ''),
        session: newCfg.session || cfg.sessionVal || '',
        keepAliveSec: Number.isFinite(newCfg.keepAliveSec) ? Number(newCfg.keepAliveSec) : cfg.keepAliveSec,
        reloadAfterSec: desiredReload,
        waitForCss: newCfg.waitForCss ?? cfg.waitForCss ?? null,
        user: newCfg.user || cfg.user || { email: '', password: '' },
  timeWindow: nextTW,
        autoReloadEnabled: autoEnabled,
        navigateBackEnabled: navBack,
    tabTimeoutSec: Number.isFinite(desiredTabTimeout) ? desiredTabTimeout : 600,
    ntpServer: nextNtpServer,
        useSystemTime: nextUseSystem,
        proxyHost: nextProxyHost,
        proxyPort: nextProxyPort,
        proxyUseHttps: nextProxyUseHttps,
        proxyEnabled: nextProxyEnabled,
        twoFAEnabled: twoFAEnabled
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
      // Persist 2FA secret if present
      if (twoFASecret) {
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
          const data = Buffer.concat([cipher.update(JSON.stringify({ secret: twoFASecret }), 'utf8'), cipher.final()]);
          const tag = cipher.getAuthTag();
          toWrite.twoFAEnc = { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
        } catch {}
      } else {
        // ensure no stale secret is written
        delete toWrite.twoFAEnc;
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
  cfg.twoFAEnabled = merged.twoFAEnabled;
  cfg.ntpServer = merged.ntpServer;
  cfg.useSystemTime = merged.useSystemTime;
  cfg.proxyHost = merged.proxyHost;
  cfg.proxyPort = merged.proxyPort;
  cfg.proxyUseHttps = merged.proxyUseHttps;
  cfg.proxyEnabled = merged.proxyEnabled;
  if (cfg.autoReloadEnabled && cfg.reloadAfterSec > 0) { try { lastAutoReloadStart = Date.now(); } catch {} }

  await configureProxy(cfg.proxyHost, cfg.proxyPort, cfg.proxyUseHttps, cfg.proxyEnabled);
  applyNtpPreferences(cfg.ntpServer, cfg.useSystemTime);

  // Update target base for watchdog and reset grace timer
  targetBase = cfg.hasUrl ? stripFromTo(cfg.targetUrl) : 'about:blank';
  try { offTargetSince = null; } catch {}

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
  icon: appIcon,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        partition: partitionName,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        enableRemoteModule: false
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

  // Watchdog: ensure we're on the configured URL; if not, redirect back (honor tabTimeoutSec as grace)
  let targetBase = stripFromTo(cfg.targetUrl);
  let offTargetSince = null; // timestamp when main deviated from targetBase
  // Track approximate start of current auto-reload interval for countdown logging
  let lastAutoReloadStart = Date.now();
  // Track if autoReload temporarily paused due to navigate-back grace
  let autoReloadPausedDueToNavigate = false;
  // Track if navigate-back itself is paused explicitly due to a login page
  let navigateBackPausedForLogin = false;
  let loginPauseSince = null;
  let nextLoginRetryAt = 0;
  const LOGIN_RETRY_INTERVAL_MS = 30 * 1000; // retry login flow every 30 seconds while stalled
  const ensureTargetUrl = () => {
    try {
      const current = win.webContents.getURL();
      if (!current) return;
      const curBase = stripFromTo(current);

      // If on a different base URL, schedule a redirect after the grace period (tabTimeoutSec)
      if (cfg.navigateBackEnabled && curBase !== targetBase) {
        const now = Date.now();
        // Detect login-like pages (avoid forcing navigate-back there)
        let isLoginPage = false;
        try {
          const uObj = new urlLib.URL(current);
          const pathLower = (uObj.pathname + ' ' + uObj.search).toLowerCase();
          if (/login|sign[-_]?in|auth|account|identity|session|passwd|password/.test(pathLower)) {
            isLoginPage = true;
          }
        } catch {}
        if (isLoginPage) {
          // Pause navigate-back logic entirely while on login pages
          if (!navigateBackPausedForLogin) {
            navigateBackPausedForLogin = true;
            loginPauseSince = Date.now();
            nextLoginRetryAt = loginPauseSince + LOGIN_RETRY_INTERVAL_MS;
          } else if (!loginPauseSince) {
            loginPauseSince = Date.now();
            nextLoginRetryAt = loginPauseSince + LOGIN_RETRY_INTERVAL_MS;
          }
          offTargetSince = null; // reset any prior deviation timer
          // Pause autoReload while on login (only once)
          if (cfg.autoReloadEnabled && !autoReloadPausedDueToNavigate) {
            try { win.webContents.send('auto-reload-stop'); } catch {}
            autoReloadPausedDueToNavigate = true;
          }
          const nowTs = Date.now();
          if (loginPauseSince && nowTs >= nextLoginRetryAt) {
            try {
              // Navigate to the app's final URL (same logic as initial load) to restart the flow
              const desiredWin = computeWindow(cfg.timeWindow.start);
              const dest = cfg.timeWindow.enabled ? withWindowParams(cfg.targetUrl, desiredWin) : cfg.targetUrl;
              console.log('[electron-auto-reload] Login pause exceeded; navigating to final URL:', dest);
              if (!win.isDestroyed()) {
                try { win.loadURL(dest).catch(() => {}); } catch {}
              }
              // After forcing navigation, retry again in at most 10 seconds if we are still stuck
              nextLoginRetryAt = nowTs + 10 * 1000;
            } catch (err) {
              console.error('[electron-auto-reload] Failed to retry login by navigation:', err);
              // If navigation failed, fall back to scheduling the standard interval
              nextLoginRetryAt = nowTs + LOGIN_RETRY_INTERVAL_MS;
            }
          }
          return; // do not proceed with navigate-back timing
        } else if (navigateBackPausedForLogin) {
          // Leaving login page; resume navigate-back timing fresh
          navigateBackPausedForLogin = false;
          loginPauseSince = null;
          nextLoginRetryAt = 0;
          offTargetSince = null;
        }
        if (!offTargetSince) {
          offTargetSince = now;
          // Pause autoReload while user is off the target page
          if (cfg.autoReloadEnabled && !autoReloadPausedDueToNavigate) {
            try { win.webContents.send('auto-reload-stop'); } catch {}
            autoReloadPausedDueToNavigate = true;
          }
          return;
        }
        const graceMs = Math.max(0, Number(cfg.tabTimeoutSec || 0) * 1000);
        const elapsed = now - offTargetSince;
        if (graceMs === 0 || elapsed >= graceMs) {
          const winRange = computeWindow(cfg.timeWindow.start);
          const dest = withWindowParams(cfg.targetUrl, winRange);
          console.log('[electron-auto-reload] Redirecting to target URL:', dest);
          win.loadURL(dest).catch(() => {});
          offTargetSince = null; // reset after redirect
        } else {
          // Still within grace period; do not redirect yet
        }
        return;
      } else {
        // Back on target; clear any grace timer
  if (offTargetSince) offTargetSince = null;
  navigateBackPausedForLogin = false;
  loginPauseSince = null;
  nextLoginRetryAt = 0;
        // Resume autoReload if it was paused due to navigate-back
        if (autoReloadPausedDueToNavigate && cfg.autoReloadEnabled && cfg.reloadAfterSec > 0) {
          try { lastAutoReloadStart = Date.now(); } catch {}
          try { win.webContents.send('auto-reload-start'); } catch {}
        }
        autoReloadPausedDueToNavigate = false;
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
  const watchdogId = setInterval(ensureTargetUrl, 5 * 1000);
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
        const thresholdMs = Number(cfg.tabTimeoutSec) * 1000;
        if (aliveMs >= thresholdMs) {
          try {
            const aliveSec = Math.round(aliveMs / 1000);
            const threshSec = Math.round(thresholdMs / 1000);
            console.log(`[auto-reload][child] closing (alive=${aliveSec}s >= threshold=${threshSec}s)`);
          } catch {}
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

  // Countdown logger every 10s when AutoReload or Navigate Back active
  const countdownLoggerId = setInterval(() => {
    try {
      const segs = [];
      const now = Date.now();
      if (cfg.autoReloadEnabled && cfg.reloadAfterSec > 0) {
        const cycleMs = cfg.reloadAfterSec * 1000;
        let nextAt = lastAutoReloadStart + cycleMs;
        if (now >= nextAt) { // renderer probably reloaded already; reset baseline
          lastAutoReloadStart = now;
          nextAt = lastAutoReloadStart + cycleMs;
        }
        const remain = Math.max(0, Math.round((nextAt - now) / 1000));
        segs.push(`autoReload ${autoReloadPausedDueToNavigate ? 'paused(navigateBack)' : remain + 's'}`);
      }
      if (cfg.navigateBackEnabled && cfg.tabTimeoutSec > 0) {
        if (navigateBackPausedForLogin) {
          const pausedFor = loginPauseSince ? Math.max(0, Math.round((now - loginPauseSince) / 1000)) : 0;
          const retryIn = nextLoginRetryAt > now ? Math.max(0, Math.round((nextLoginRetryAt - now) / 1000)) : 0;
          const detail = retryIn > 0
            ? `navigateBack paused(login ${pausedFor}s, retry in ${retryIn}s)`
            : `navigateBack paused(login ${pausedFor}s, retrying)`;
          segs.push(detail);
        } else if (offTargetSince) {
          const graceMs = cfg.tabTimeoutSec * 1000;
          const elapsed = now - offTargetSince;
          const remain = Math.max(0, Math.round((graceMs - elapsed) / 1000));
          segs.push(`navigateBack ${remain}s`);
        } else {
          segs.push('navigateBack idle');
        }
      }
      if (segs.length) console.log('[electron-auto-reload][countdown]', segs.join(' | '));
    } catch {}
  }, 10 * 1000);
  win.on('closed', () => { try { clearInterval(countdownLoggerId); } catch {} });

  // Menu with Settings and Auto-Reload controls
  const openSettings = () => {
    const settingsWin = new BrowserWindow({
      width: 700,
      height: 700,
      title: 'Settings',
      modal: false,
      parent: win,
  icon: appIcon,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
        sandbox: true,
        enableRemoteModule: false
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

  // User activity resets auto-reload countdown and navigate-back grace timer start
  ipcMain.on('user-activity', () => {
    try {
      lastAutoReloadStart = Date.now();
      if (offTargetSince) {
        // Give full grace again on interaction
        offTargetSince = Date.now();
      }
      if (navigateBackPausedForLogin) {
        loginPauseSince = Date.now();
        nextLoginRetryAt = loginPauseSince + LOGIN_RETRY_INTERVAL_MS;
      }
    } catch {}
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
          click: (menuItem) => {
            if (!cfg.hasUrl) { menuItem.checked = false; return; }
            // Toggle
            const enable = menuItem.checked;
            let newReload = cfg.reloadAfterSec;
            if (enable && (!Number.isFinite(newReload) || newReload <= 0)) {
              newReload = 250; // default when enabling via menu
            }
            // Persist config and update in-memory
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
              try { lastAutoReloadStart = Date.now(); } catch {}
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

  // Suppress noisy DevTools Autofill protocol errors on Chromium builds without the domain
  const suppressedDevtoolsMessages = [
    'Request Autofill.enable failed',
    'Request Autofill.setAddresses failed'
  ];
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    try {
      if (typeof message === 'string' && sourceId && sourceId.startsWith('devtools://')) {
        if (suppressedDevtoolsMessages.some(txt => message.indexOf(txt) !== -1)) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          return;
        }
      }
    } catch {}
  });

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
