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

      // Throttling: when server says too many attempts, wait 5 minutes
      const FIVE_MIN = 5 * 60 * 1000;
      let lockUntil = Number.isFinite(window.__twoFALockUntil) ? Number(window.__twoFALockUntil) : 0;
      let lockLogTimer = window.__twoFALockLogTimer || null;

      function formatRemain(ms){
        const sec = Math.max(0, Math.ceil(ms/1000));
        const m = Math.floor(sec/60), s = sec%60;
        return `${m}m ${s}s`;
      }

      function hasTooManyAttemptsMessage(){
        try {
          // Precise detection per provided markup
          const el = document.querySelector('[data-error-code="too-many-failures"]');
          if (el && (el.textContent||'').toLowerCase().includes('too many failed codes')) return true;
          // Fallback: text scan
          const txt = (document.body && (document.body.innerText || document.body.textContent)) || '';
          if (!txt) return false;
          const s = txt.toLowerCase();
          const tooMany = s.includes('too many failed codes') || (s.includes('too many') && (s.includes('code') || s.includes('codes') || s.includes('attempt')));
          const waitMsg = /wait\s+\d+\s*minute/.test(s) || s.includes('wait for some minutes');
          return tooMany || waitMsg;
        } catch { return false; }
      }

      function typeChars(el, text){
        try {
          el.focus();
          // Fill in a single shot instead of per-character typing
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) {
            setter.call(el, '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            setter.call(el, String(text ?? ''));
          } else {
            el.value = String(text ?? '');
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
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
        // Single attempt: click once and mark submitted to avoid retries
        fireClick(btn);
        window.__twoFASubmitted = true;
        // Safety: if click didn't trigger submit handlers, send Enter once
        try {
          input.focus();
          ['keydown','keypress','keyup'].forEach(k=> input.dispatchEvent(new KeyboardEvent(k,{bubbles:true,key:'Enter',code:'Enter'})));
        } catch {}
      }

      const start = performance.now();
      let afterFillBurst = false;
      function attempt(){
        if (!active || window.__twoFASubmitted) return;
        const now = Date.now();
        // Respect lock window (e.g., after "too many failed codes")
        if (lockUntil && now < lockUntil) {
          // Periodic log while waiting
          if (!lockLogTimer) {
            lockLogTimer = setInterval(()=>{
              const remain = Math.max(0, (lockUntil - Date.now()));
              try { console.log(`[2FA] Waiting due to throttle: ${formatRemain(remain)} remaining (until ${new Date(lockUntil).toLocaleTimeString()})`); } catch {}
              if (Date.now() >= lockUntil) { try { clearInterval(lockLogTimer); } catch {}; lockLogTimer = null; window.__twoFALockLogTimer = null; }
            }, 30000); // log every 30s
            window.__twoFALockLogTimer = lockLogTimer;
          }
          const delay = Math.min(5000, lockUntil - now);
          setTimeout(attempt, Math.max(500, delay));
          return;
        } else if (lockUntil && now >= lockUntil) {
          // Lock expired, clear any log timer
          if (lockLogTimer) { try { clearInterval(lockLogTimer); } catch {}; lockLogTimer = null; window.__twoFALockLogTimer = null; }
        }
        // If page shows throttle message, set lock for five minutes and pause attempts
        if (hasTooManyAttemptsMessage()) {
          if (!lockUntil || now >= lockUntil) {
            lockUntil = Date.now() + FIVE_MIN;
            window.__twoFALockUntil = lockUntil;
            try { console.log(`[2FA] Throttled: Too many failed codes. Waiting 5 minutes (until ${new Date(lockUntil).toLocaleTimeString()}) before retrying.`); } catch {}
            // Start periodic log timer immediately
            if (!lockLogTimer) {
              lockLogTimer = setInterval(()=>{
                const remain = Math.max(0, (lockUntil - Date.now()));
                try { console.log(`[2FA] Waiting due to throttle: ${formatRemain(remain)} remaining (until ${new Date(lockUntil).toLocaleTimeString()})`); } catch {}
                if (Date.now() >= lockUntil) { try { clearInterval(lockLogTimer); } catch {}; lockLogTimer = null; window.__twoFALockLogTimer = null; }
              }, 30000);
              window.__twoFALockLogTimer = lockLogTimer;
            }
          }
          setTimeout(attempt, 5000);
          return;
        }
        const code = window.__currentTOTPCode || lastCode;
        const elapsed = performance.now() - start;
        if (elapsed > 10000) { // hard cap 10s unless we're in lock mode
          if (lockUntil && Date.now() < lockUntil) {
            // Keep observer alive; schedule next check near lock expiry
            const delay = Math.min(5000, lockUntil - Date.now());
            setTimeout(attempt, Math.max(500, delay));
            return;
          }
          stop(); return;
        }
        if (!code || code.length < 6){ queueNext(); return; }
        let el=null; for (const s of selectors){ const c=document.querySelector(s); if (c){ el=c; break; } }
        if (!el){ queueNext(); return; }
        if (el.value.trim() !== code) {
          typeChars(el, code);
          // Do not burst-submit; we'll submit once below
          afterFillBurst = true;
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
      // Removed aggressive continuousSubmit; we attempt only once per page load
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

    const loginLog = (step, details) => {
      try {
        const suffix = details ? ` | ${details}` : '';
        console.log(`[auto-login] ${step}${suffix}`);
      } catch {}
    };

    const describeBtnState = (btn) => {
      if (!btn) return 'absent';
      const aria = btn.getAttribute('aria-disabled');
      return `disabled=${btn.disabled} aria-disabled=${aria ?? ''} class="${btn.className || ''}"`;
    };

    const monitorButtonState = (btn, label) => {
      if (!btn) return;
      const logState = (reason) => loginLog(`${label}-${reason}`, describeBtnState(btn));
      logState('initial');
      let lastSnapshot = describeBtnState(btn);
      try {
        const observer = new MutationObserver(() => {
          const snap = describeBtnState(btn);
          if (snap !== lastSnapshot) {
            lastSnapshot = snap;
            logState('mutation');
          }
        });
        observer.observe(btn, { attributes: true, attributeFilter: ['class', 'disabled', 'aria-disabled'] });
        setTimeout(() => { logState('after-2s'); }, 2000);
        setTimeout(() => {
          logState('after-5s');
          try { observer.disconnect(); } catch {}
        }, 5000);
      } catch {}
    };

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    const setNativeValue = (el, value) => {
      try {
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, value);
        } else {
          el.value = value;
        }
      } catch {
        el.value = value;
      }
    };

    const keyCodeForChar = (ch) => {
      if (!ch || typeof ch !== 'string') return { code: 'KeyA', keyCode: 65 };
      if (/^[a-z]$/i.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0) };
      if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0) };
      switch (ch) {
        case '@': return { code: 'Digit2', keyCode: 50 };
        case '.': return { code: 'Period', keyCode: 190 };
        case '-': return { code: 'Minus', keyCode: 189 };
        case '_': return { code: 'Minus', keyCode: 189 };
        case '\\': return { code: 'Backslash', keyCode: 220 };
        default: return { code: `Key${ch.toUpperCase()}`, keyCode: ch.charCodeAt(0) || 65 };
      }
    };

    async function simulateTyping(input, text, label) {
      // Single-shot fill (no per-character events)
      const val = String(text ?? '');
      loginLog(`${label}-fill-start`, `len=${val.length}`);
      setNativeValue(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(60);
      loginLog(`${label}-fill-complete`, `len=${val.length}`);
    }

    const pointerTap = (element) => {
      try {
        const rect = element.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'].forEach((type) => {
          try { element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy })); } catch {}
        });
      } catch {}
    };

    async function attemptClickSequence(btn, label, options = {}) {
      const { pokeWhileDisabled = true } = options;
      monitorButtonState(btn, label);
      loginLog(`${label}-attempt`, describeBtnState(btn));
      if (!pokeWhileDisabled) {
        try { btn.focus(); } catch {}
      }
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
        if (!disabled) {
          loginLog(`${label}-enabled`, describeBtnState(btn));
          try { btn.focus(); } catch {}
          pointerTap(btn);
          try {
            btn.click();
            loginLog(`${label}-click-dispatched`, describeBtnState(btn));
          } catch (err) {
            loginLog(`${label}-click-error`, err && err.message ? err.message : String(err));
          }
          await sleep(600);
          return true;
        }
        if (pokeWhileDisabled) pointerTap(btn);
        await sleep(150);
      }
      loginLog(`${label}-timeout-disabled`, describeBtnState(btn));
      const form = btn.form || btn.closest('form');
      if (form) {
        loginLog(`${label}-fallback-submit`);
        try {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit(btn);
          } else {
            form.submit();
          }
          loginLog(`${label}-fallback-dispatched`);
          return true;
        } catch (err) {
          loginLog(`${label}-fallback-error`, err && err.message ? err.message : String(err));
        }
      }
      return false;
    }

    async function waitForValue(element, predicate, timeoutMs, label) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          if (predicate(element)) return true;
        } catch {}
        await sleep(60);
      }
      loginLog(`${label}-timeout`);
      return false;
    }

    async function sendKeyStroke(target, key, code, keyCode, label) {
      if (!target) return;
      const eventInit = {
        bubbles: true,
        key,
        code,
        keyCode,
        which: keyCode
      };
      loginLog(`${label}-keydown`);
      try { target.dispatchEvent(new KeyboardEvent('keydown', eventInit)); } catch {}
      try { target.dispatchEvent(new KeyboardEvent('keypress', eventInit)); } catch {}
      try { target.dispatchEvent(new KeyboardEvent('keyup', eventInit)); } catch {}
      await sleep(40);
    }

    async function sendEnter(target, label) {
      await sendKeyStroke(target, 'Enter', 'Enter', 13, label);
    }

    loginLog('start', location.href);

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
      loginLog('email-found', emailInput.outerHTML.slice(0, 120));
      emailInput.focus();
      await simulateTyping(emailInput, user.email, 'email-input');
      await sendKeyStroke(emailInput, 'Tab', 'Tab', 9, 'email-tab');
      await sleep(120);
      // Wait for Cloudflare/Turnstile token readiness before continuing
      let captchaReady = false;
      try {
        captchaReady = await waitForCaptcha(90000);
      } catch (err) {
        loginLog('email-captcha-error', err && err.message ? err.message : String(err));
      }
      loginLog('email-captcha-ready', String(captchaReady));
      const nextBtn = findAny(nextSel);
      // Try ticking known checkboxes early if present on step 1
      try { clickKnownCheckboxes(); } catch {}
      let passwordVisiblePreSubmit = findAny(passSel);
      if (!passwordVisiblePreSubmit) {
        const waitStart = Date.now();
        while (!passwordVisiblePreSubmit && Date.now() - waitStart < 800) {
          await sleep(80);
          passwordVisiblePreSubmit = findAny(passSel);
        }
      }
      if (passwordVisiblePreSubmit) {
        loginLog('password-visible-pre-submit', passwordVisiblePreSubmit.outerHTML.slice(0, 120));
      } else if (nextBtn) {
        const btnText = ((nextBtn.textContent || '').trim().toLowerCase());
        const continueWords = ['next', 'continue', 'proceed', 'verify', 'email'];
        const isContinue = continueWords.some(word => btnText.includes(word));
        if (isContinue) {
          loginLog('email-submit-continue', btnText || '(no-text)');
          await attemptClickSequence(nextBtn, 'email-submit', { pokeWhileDisabled: true });
        } else {
          loginLog('email-submit-skipped', btnText || '(no-text)');
        }
      } else {
        loginLog('email-submit-missing');
      }
      // After moving to next step, keep trying to tick checkboxes for a bit
      ensureCheckboxes(12000).catch(() => {});
    } else {
      loginLog('email-input-missing');
    }

    // Wait briefly for password to appear
    let tries = 0;
    while (!findAny(passSel) && tries < 200) { // up to ~20s
      await sleep(100);
      tries++;
    }

    const passInput = findAny(passSel);
    if (passInput) {
      loginLog('password-found', passInput.outerHTML.slice(0, 120));
      passInput.focus();
      await simulateTyping(passInput, user.password, 'password-input');
      const filled = await waitForValue(passInput, (el) => el && el.value === user.password, 5000, 'password-filled');
      loginLog('password-filled-status', `match=${filled} len=${passInput.value.length}`);
      try {
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        passInput.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {}
      try { passInput.blur(); } catch {}
      await sleep(120);
      await sendEnter(passInput, 'password-enter');

      // Find a submit button on the password page
      const nextBtn2 = findAny(['#idSIButton9', 'button[type="submit"]', 'input[type="submit"]']);
      // Try ticking known checkboxes prior to submitting password step
      try { clickKnownCheckboxes(); } catch {}
      if (nextBtn2) {
        loginLog('password-submit-found', nextBtn2.outerHTML.slice(0, 120));
        await attemptClickSequence(nextBtn2, 'password-submit', { pokeWhileDisabled: false });
      } else {
        loginLog('password-submit-missing');
      }

      // Optionally handle "Stay signed in" prompt
      setTimeout(() => {
        try { clickKnownCheckboxes(); } catch {}
        const stayYes = document.querySelector('#idSIButton9');
        if (stayYes) try { stayYes.click(); } catch {}
      }, 1500);
      // And keep trying for a while as that prompt can appear late
      ensureCheckboxes(15000).catch(() => {});

      // If a CAPTCHA interrupts at this stage, wait for solve then try submit again (once)
      try {
        const solved = await waitForCaptcha(90000);
        loginLog('password-captcha-result', String(solved));
        if (solved) {
          const submitAgain = findAny(['#idSIButton9', 'button[type="submit"]', 'input[type="submit"]']);
          if (submitAgain) {
            loginLog('password-submit-retry-found', submitAgain.outerHTML.slice(0, 120));
            await attemptClickSequence(submitAgain, 'password-submit-retry', { pokeWhileDisabled: false });
          } else {
            loginLog('password-submit-retry-missing');
          }
        }
      } catch (err) {
        loginLog('password-captcha-error', err && err.message ? err.message : String(err));
      }
      loginLog('password-step-complete');
      return true;
    }
    loginLog('password-input-missing');
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
