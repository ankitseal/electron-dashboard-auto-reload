// Preload script: inject keep-alive and auto-reload from config
const { contextBridge, ipcRenderer } = require('electron');

// NOTE: Previous complex 2FA fast-path & multi-box logic removed.
// New streamlined approach implemented inside applyBehaviors().

// High-frequency ultra-early 2FA fill & submit
(function earlyFast2FA(){
  try {
    ipcRenderer.invoke('get-2fa-state').then(st => {
      if (!st || !st.enabled) return;
      let active = true;
      const selectors = ['#code','input#code','input[name="code"]','input[autocomplete="one-time-code"]'];
      let lastCode = '';
      async function refreshCode(){ try { window.__currentTOTPCode = await ipcRenderer.invoke('get-totp-code'); if (window.__currentTOTPCode) lastCode = window.__currentTOTPCode; } catch {} }
      refreshCode();
      const codeTimer = setInterval(refreshCode, 600); // slightly faster cadence

      function typeChars(el, text){
        try {
          el.focus();
          el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));
          for (const ch of text){
            el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:ch}));
            el.dispatchEvent(new KeyboardEvent('keypress',{bubbles:true,key:ch}));
            el.value += ch;
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:ch}));
          }
          el.dispatchEvent(new Event('change',{bubbles:true}));
        } catch {}
      }

      function fireClick(btn){
        const r = btn.getBoundingClientRect();
        const cx = r.left + r.width/2, cy = r.top + r.height/2;
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(ev=>{ try { btn.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,clientX:cx,clientY:cy})); } catch {} });
      }

      function submit(input){
        if (window.__twoFASubmitted) return;
        const form = input.form || input.closest('form');
        const btn = form?.querySelector('button[data-action-button-primary="true"], button[type="submit"], input[type="submit"]') || document.querySelector('button[data-action-button-primary="true"], button[type="submit"], input[type="submit"]');
        if (btn){
          if (!(btn.disabled||btn.getAttribute('aria-disabled')==='true')) {
            tryImmediateSubmit(btn, form, input);
            return;
          }
          const obs = new MutationObserver(()=>{
            if (!(btn.disabled||btn.getAttribute('aria-disabled')==='true')) { tryImmediateSubmit(btn, form, input); try { obs.disconnect(); } catch {}; }
          });
          try { obs.observe(btn,{attributes:true,attributeFilter:['disabled','aria-disabled','class']}); } catch {}
        }
        if (!window.__twoFASubmitted && form){ // fallback if no button
          try { (form.requestSubmit?form.requestSubmit():form.submit()); window.__twoFASubmitted = true; } catch {}
        }
      }

      function tryImmediateSubmit(btn, form, input){
        if (window.__twoFASubmitted) return;
        // Blur input so some frameworks validate
        try { input.blur(); } catch {}
        fireClick(btn);
        if (!window.__twoFASubmitted) {
          // Simulate Enter key on input if click didn't trigger
          try {
            input.focus();
            ['keydown','keypress','keyup'].forEach(k=> input.dispatchEvent(new KeyboardEvent(k,{bubbles:true,key:'Enter',code:'Enter'})));
          } catch {}
        }
        // Rapid rAF burst attempts for up to 800ms until navigation/submit is detected
        if (!window.__twoFABurstLoop) {
          window.__twoFABurstLoop = true;
          const start = performance.now();
          (function burst(){
            if (window.__twoFASubmitted) return;
            const elapsed = performance.now()-start;
            if (btn && !(btn.disabled||btn.getAttribute('aria-disabled')==='true')) {
              fireClick(btn);
            }
            if (!window.__twoFASubmitted && elapsed < 800) requestAnimationFrame(burst);
          })();
          // Timed ultimate fallback: raw form submit after 900ms
          setTimeout(()=>{
            if (!window.__twoFASubmitted && form) {
              try { (form.requestSubmit?form.requestSubmit():form.submit()); window.__twoFASubmitted = true; } catch {}
            }
          },900);
        }
      }

      const start = performance.now();
      let afterFillBurst = false;
      function attempt(){
        if (!active || window.__twoFASubmitted) return;
        const code = window.__currentTOTPCode || lastCode;
        const elapsed = performance.now() - start;
        if (elapsed > 10000) { stop(); return; } // hard cap 10s
        if (!code || code.length < 6){ queueNext(); return; }
        let el=null; for (const s of selectors){ const c=document.querySelector(s); if (c){ el=c; break; } }
        if (!el){ queueNext(); return; }
        if (el.value.trim() !== code) {
          typeChars(el, code);
          // Start an intense burst loop immediately after first full fill
          if (!afterFillBurst) { afterFillBurst = true; continuousSubmit(el); }
        }
        submit(el);
        if (window.__twoFASubmitted) { stop(); return; }
        queueNext();
      }
      function queueNext(){
        if (!active || window.__twoFASubmitted) return;
        const elapsed=performance.now()-start;
        if (elapsed<1000) { requestAnimationFrame(attempt); }
        else if (elapsed<5000) { setTimeout(attempt,30); }
        else { setTimeout(attempt,120); }
      }
      function continuousSubmit(input){
        const form = input.form || input.closest('form');
        let frames = 0;
        (function loop(){
          if (window.__twoFASubmitted || !active) return;
            frames++;
            const btn = form?.querySelector('button[data-action-button-primary="true"], button[type="submit"], input[type="submit"]') || document.querySelector('button[data-action-button-primary="true"], button[type="submit"], input[type="submit"]');
            if (btn && !(btn.disabled||btn.getAttribute('aria-disabled')==='true')) {
              fireClick(btn);
              // Also press Enter occasionally to trigger any onKey handlers
              if (frames % 5 === 0) {
                ['keydown','keypress','keyup'].forEach(k=> input.dispatchEvent(new KeyboardEvent(k,{bubbles:true,key:'Enter',code:'Enter'})));
              }
            }
            if (!window.__twoFASubmitted && frames < 120) requestAnimationFrame(loop);
        })();
      }
      const mo = new MutationObserver(()=>attempt());
      try { mo.observe(document.documentElement||document,{childList:true,subtree:true}); } catch {}
      function stop(){ active=false; clearInterval(codeTimer); try{ mo.disconnect(); }catch{} }
      attempt();
    }).catch(()=>{});
  } catch {}
})();

async function applyBehaviors() {
  const cfg = await ipcRenderer.invoke('get-config');
  // Query 2FA status lazily via IPC only when needed

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

    // Try to tick common consent/remember checkboxes by label text or known IDs
    function clickKnownCheckboxes() {
      try {
        // Azure AAD "Stay signed in" checkbox
        const kmsi = document.getElementById('KmsiCheckboxField');
        if (kmsi && kmsi.type === 'checkbox' && !kmsi.checked && !kmsi.disabled) {
          kmsi.click();
          kmsi.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Common remember-me checkbox names/ids
        const preferred = document.querySelector(
          'input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i]'
        );
        if (preferred && !preferred.checked && !preferred.disabled) {
          preferred.click();
          preferred.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Generic remember/consent patterns
        const patterns = [
          /stay\s*signed\s*in/i,
          /keep\s*me\s*signed\s*in/i,
          /remember\s*me/i,
          /don'?t\s*show\s*this\s*again/i,
          /trust\s*this\s*device/i,
          /remember\s*this\s*device/i,
          /i\s*agree|accept|consent/i
        ];
        const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        for (const box of boxes) {
          if (box.checked || box.disabled) continue;
          let labelText = '';
          try {
            if (box.id) {
              const l = document.querySelector(`label[for="${CSS.escape(box.id)}"]`);
              if (l) labelText = l.textContent || '';
            }
            if (!labelText) {
              const l2 = box.closest('label');
              if (l2) labelText = l2.textContent || '';
            }
            if (!labelText) {
              const aria = box.getAttribute('aria-label');
              if (aria) labelText = aria;
            }
          } catch {}
          if (!labelText) continue;
          if (patterns.some(re => re.test(labelText))) {
            // Ensure visible-ish
            const rect = box.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0;
            if (visible) {
              box.click();
              box.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }
      } catch {}
    }

    // Poll for late-loading checkboxes for a short period
    async function ensureCheckboxes(timeoutMs = 15000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
  try { clickKnownCheckboxes(); } catch {}
  try { attemptCloudflareCheckbox(); } catch {}
        await sleep(500);
      }
    }

  async function waitForCaptcha(maxMs = 60000) {
      const start = Date.now();
      // Generic wait for common CAPTCHA widgets to be solved.
      // Signals:
      //  - Turnstile: window.cf or input[name="cf-turnstile-response"] populated
      //  - reCAPTCHA: textarea#g-recaptcha-response populated
      //  - Auth0/ULP: hidden captcha input gets a value or captcha container disappears
      while (Date.now() - start < maxMs) {
        // Try pro-actively clicking common checkbox captchas if present
  try { attemptCloudflareCheckbox(); } catch {}

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
  // Try ticking known checkboxes early if present on step 1
  try { clickKnownCheckboxes(); } catch {}
  if (nextBtn) nextBtn.click();
  // After moving to next step, keep trying to tick checkboxes for a bit
  ensureCheckboxes(12000).catch(()=>{});
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
      // Try ticking known checkboxes prior to submitting password step
      try { clickKnownCheckboxes(); } catch {}
  if (nextBtn2) nextBtn2.click();

      // Optionally handle "Stay signed in" prompt
      setTimeout(() => {
        try { clickKnownCheckboxes(); } catch {}
        const stayYes = document.querySelector('#idSIButton9');
        if (stayYes) try { stayYes.click(); } catch {}
      }, 1500);
  // And keep trying for a while as that prompt can appear late
  ensureCheckboxes(15000).catch(()=>{});

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

  // Attempt to proactively click Cloudflare/Turnstile style checkbox challenges.
  function attemptCloudflareCheckbox() {
    // Direct checkbox inside common containers
    const checkboxSelectors = [
      '.cb-c input[type="checkbox"]',
      'label.cb-lb input[type="checkbox"]',
      '.cf-challenge input[type="checkbox"]',
      '.cf-turnstile input[type="checkbox"]',
      'input[type="checkbox"][aria-label*="verify" i]',
      'input[type="checkbox"][aria-label*="human" i]'
    ];
    for (const sel of checkboxSelectors) {
      const el = document.querySelector(sel);
      if (el && !el.checked && !el.disabled) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el.click();
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
    // If only the container exists (iframe challenge), try clicking center to simulate user intent
    const containers = Array.from(document.querySelectorAll('.cf-turnstile, .cf-challenge, .cb-c, iframe[id^="cf-chl-widget"], iframe[title*="Cloudflare security challenge" i]'));
    for (const container of containers) {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
          try { container.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 })); } catch {}
        });
      }
    }

    // --- Deep iframe checkbox attempt (user supplied XPath-like path) ---------
    // Strategy: iterate visible iframes in login form area; if same-origin look for a checkbox; else click center.
    try {
      const iframes = Array.from(document.querySelectorAll('form iframe, iframe'));
      for (const frame of iframes) {
        const r = frame.getBoundingClientRect();
        if (r.width < 24 || r.height < 24 || r.width > 800 || r.height > 800) continue; // ignore tiny/huge noise
        if (r.bottom < 0 || r.right < 0 || r.left > window.innerWidth || r.top > window.innerHeight) continue; // off-screen
        let clicked = false;
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) {
            // Look for explicit checkbox first
            const innerBox = doc.querySelector('input[type="checkbox"], input[role="checkbox"], div[role="checkbox"]');
            if (innerBox) {
              const ir = innerBox.getBoundingClientRect();
              // Synthesize events inside frame context if possible
              try { innerBox.click(); clicked = true; } catch {}
              if (!clicked) {
                try { innerBox.dispatchEvent(new Event('click', { bubbles: true })); clicked = true; } catch {}
              }
              if (clicked) {
                try { innerBox.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                return true;
              }
            }
          }
        } catch { /* cross-origin */ }
        if (!clicked) {
          // Cross-origin fallback: click center of iframe hoping checkbox centered
            ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(ev => {
              try { frame.dispatchEvent(new MouseEvent(ev, { bubbles:true, cancelable:true, clientX: r.left + r.width/2, clientY: r.top + r.height/2 })); } catch {}
            });
        }
      }
    } catch {}
    return false;
  }

  // Fire early attempts for Cloudflare checkbox before any form actions
  let earlyCloudflareTries = 0;
  const earlyTimer = setInterval(() => {
    try { attemptCloudflareCheckbox(); } catch {}
    earlyCloudflareTries++;
    if (earlyCloudflareTries > 40) { clearInterval(earlyTimer); }
  }, 500);

  // Determine if we are already on the target origin (i.e., session still valid)
  const onTargetOrigin = targetOrigin && location.origin === targetOrigin;
  if (!onTargetOrigin) {
    try {
      const did = await tryLogin();
    } catch {}
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

  // Throttled user activity ping to main process to reset counters
  const { ipcRenderer } = require('electron');
  let lastPing = 0;
  function activityHandler(){
    const now = Date.now();
    if (now - lastPing > 2000) { // throttle every 2s
      // (Removed scheduleRapidSubmit & simulateTyping; not needed in simplified flow.)
      lastPing = now;
      try { ipcRenderer.send('user-activity'); } catch {}
    }
  }
  ['mousemove','mousedown','keydown','touchstart','wheel','click'].forEach(ev => {
    window.addEventListener(ev, activityHandler, { passive: true });
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
