// Preload script: inject keep-alive and auto-reload from config
const { contextBridge, ipcRenderer } = require('electron');

async function applyBehaviors() {
  const cfg = await ipcRenderer.invoke('get-config');

  const waitForCss = cfg.waitForCss || null;
  const reloadAfterMs = Number.isFinite(cfg.reloadAfterSec)
    ? Math.max(0, Number(cfg.reloadAfterSec)) * 1000
    : 300000;
  const autoReloadEnabled = !!cfg.autoReloadEnabled && reloadAfterMs > 0;
  const keepAliveSec = Number(cfg.keepAliveSec || 0);
  const user = cfg.user || { email: '', password: '' };
  const targetOrigin = (() => { try { return new URL(cfg.targetUrl).origin; } catch { return null; } })();

  // Helper: wait for DOM
  function domReady() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
  }

  await domReady();

  // If redirected to login, attempt auto-fill if credentials are provided
  async function tryLogin() {
    if (!user.email || !user.password) return false;

    // Heuristics for Microsoft AAD/Siemens login pages
    const emailSel = ['#username', 'input[name="loginfmt"]', 'input[type="email"]', 'input[name="username"]'];
    // On email step, the button might say Continue with classes like _button-login-id
    const nextSel = ['button._button-login-id', '#idSIButton9', 'input[type="submit"]', 'button[type="submit"]'];
    const passSel = ['input[name="passwd"]', 'input[type="password"]', '#password'];

    function findAny(selectors) {
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    }

    function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

    async function waitForCaptcha(maxMs = 60000) {
      const start = Date.now();
      // Generic wait for common CAPTCHA widgets to be solved.
      // Signals:
      //  - Turnstile: window.cf or input[name="cf-turnstile-response"] populated
      //  - reCAPTCHA: textarea#g-recaptcha-response populated
      //  - Auth0/ULP: hidden captcha input gets a value or captcha container disappears
      while (Date.now() - start < maxMs) {
        // Try pro-actively clicking common checkbox captchas if present
        try {
          const checkboxCandidates = [
            '.cb-c input[type="checkbox"]',
            'label.cb-lb input[type="checkbox"]',
            'input[type="checkbox"][aria-label*="Verify"]',
            'input[type="checkbox"][aria-label*="human"]',
            'input[type="checkbox"][id*="human"]',
            'input[type="checkbox"][name*="human"]'
          ];
          for (const sel of checkboxCandidates) {
            const el = document.querySelector(sel);
            if (el && !el.checked && !el.disabled) {
              // Ensure visible-ish
              const rect = el.getBoundingClientRect();
              const visible = rect.width > 0 && rect.height > 0;
              if (visible) {
                el.click();
                // Some UIs require clicking the styled span
                const sty = el.closest('label')?.querySelector('.cb-i');
                try { if (sty) sty.click(); } catch {}
              }
            }
          }
        } catch {}

        const capInput = document.querySelector('input[name="captcha"], input[name="cf-turnstile-response"], textarea#g-recaptcha-response');
        if (capInput && typeof capInput.value === 'string' && capInput.value.length > 0) return true;

        if (window.turnstile || window.cf) {
          // Some pages expose a token via a hidden input; give it a little more time
          const token = document.querySelector('input[name="cf-turnstile-response"]');
          if (token && token.value) return true;
        }

        const capContainer = document.querySelector('.ulp-auth0-v2-captcha, .ulp-captcha-container, .cf-challenge, .grecaptcha-badge, .main-wrapper .cb-c');
        // If container is gone, assume solved after a tiny grace
        if (!capContainer) { await sleep(200); return true; }
        await sleep(300);
      }
      return false;
    }

    // Phase 1: email
    const emailInput = findAny(emailSel);
    if (emailInput) {
      emailInput.focus();
      emailInput.value = '';
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.value = user.email;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      // Wait for Cloudflare/Turnstile token readiness before continuing
      try { await waitForCaptcha(90000); } catch {}
  const nextBtn = findAny(nextSel);
      if (nextBtn) nextBtn.click();
    }

    // Wait briefly for password to appear
    let tries = 0;
    while (!findAny(passSel) && tries < 200) { // up to ~20s
      await sleep(100);
      tries++;
    }

  const passInput = findAny(passSel);
    if (passInput) {
      passInput.focus();
      passInput.value = '';
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      passInput.value = user.password;
      passInput.dispatchEvent(new Event('input', { bubbles: true }));

      // Find a submit button on the password page
      const nextBtn2 = findAny(['#idSIButton9', 'button[type="submit"]', 'input[type="submit"]']);
      if (nextBtn2) nextBtn2.click();

      // Optionally handle "Stay signed in" prompt
      setTimeout(() => {
        const stayYes = document.querySelector('#idSIButton9');
        if (stayYes) try { stayYes.click(); } catch {}
      }, 1500);

      // If a CAPTCHA interrupts at this stage, wait for solve then try submit again (once)
      try {
        const solved = await waitForCaptcha(90000);
        if (solved) {
          const submitAgain = findAny(['#idSIButton9', 'button[type="submit"]', 'input[type="submit"]']);
          if (submitAgain) submitAgain.click();
        }
      } catch {}
      return true;
    }
    return !!emailInput;
  }

  // Determine if we are already on the target origin (i.e., session still valid)
  const onTargetOrigin = targetOrigin && location.origin === targetOrigin;
  if (!onTargetOrigin) {
    try { await tryLogin(); } catch {}
  }

  // Optional: wait for CSS selector
  if (waitForCss) {
    const start = Date.now();
    const timeoutMs = 20000;
    await new Promise(resolve => {
      if (document.querySelector(waitForCss)) return resolve();
      const obs = new MutationObserver(() => {
        if (document.querySelector(waitForCss)) {
          obs.disconnect();
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          obs.disconnect();
          resolve();
        }
      });
      obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
      setTimeout(() => { try { obs.disconnect(); } catch {} ; resolve(); }, timeoutMs);
    });
  }

  // Re-attempt login on SPA route changes too
  window.addEventListener('hashchange', () => { tryLogin().catch(()=>{}); });
  window.addEventListener('popstate', () => { tryLogin().catch(()=>{}); });

  // Keep-alive pings only when on target origin
  try { clearInterval(window.__keepAlive); } catch {}
  if (keepAliveSec > 0 && (targetOrigin ? location.origin === targetOrigin : true)) {
    const baseUrl = location.href.split('#')[0];
    window.__keepAlive = setInterval(() => {
      try {
        const u = new URL(baseUrl);
        u.searchParams.set('_ka', Date.now().toString());
        fetch(u.toString(), {
          method: 'HEAD',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'manual'
        }).catch(() => {});
      } catch {}
    }, keepAliveSec * 1000);
  }

  // Periodic reload only when on target origin
  function scheduleReload() {
    try { clearTimeout(window.__autoReload); } catch {}
    if (autoReloadEnabled && (targetOrigin ? location.origin === targetOrigin : true)) {
      window.__autoReload = setTimeout(() => {
        location.reload();
      }, reloadAfterMs);
    }
  }
  scheduleReload();

  // Respond to start/stop from menu
  ipcRenderer.on('auto-reload-start', () => scheduleReload());
  ipcRenderer.on('auto-reload-stop', () => { try { clearTimeout(window.__autoReload); } catch {} });
}

// Run after document start
(function init() {
  // Some pages block reload via beforeunload—neutralize gently
  window.addEventListener('beforeunload', (e) => {
    // allow reloads
    delete e.returnValue;
  });

  // Kick off when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyBehaviors, { once: true });
  } else {
    applyBehaviors();
  }
})();

contextBridge.exposeInMainWorld('AutoReload', {
  ping: () => true
});

// Minimal app control API for non-privileged pages (e.g., missing-settings screen)
contextBridge.exposeInMainWorld('App', {
  openSettings: () => ipcRenderer.send('open-settings')
});
