package com.ankitseal.dashboardautoreload

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.http.SslError
import androidx.appcompat.app.AppCompatActivity
import com.ankitseal.dashboardautoreload.databinding.ActivityMainBinding
import java.net.URL
import java.util.*

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var cfgStore: ConfigStore
    private var cfg: ConfigStore.Config = ConfigStore.Config()

    private val mainHandler = Handler(Looper.getMainLooper())
    private var keepAliveTimer: Timer? = null // deprecated (removed feature)
    private var reloadRunnable: Runnable? = null
    private val TAG = "DAR.MainActivity"
    private var lastGoodUrl: String? = null

    private var initialUrlLogged = false
    private var reloadCount = 0
    // Event-driven scheduling (replaces adaptive polling loop)
    private var scheduledRunnable: Runnable? = null
    private var reloadFireAt: Long = 0L
    private var autoReloadRunning = false // legacy flag (kept for compatibility)
    private var autoReloadActive = false
    private var lastInteractionMs: Long = 0L
    private var lastAutoReloadResetInteractionMs: Long = 0L
    // navigate-back state
    private var navBackActive = false
    // removed log bucket for navigateBack in event model
    private var navigateBackCycle = 0
    private var lastNavBackIntervalSec: Int = -1
    private var lastPageUrl: String = ""
    private var lastInteractionAt: Long = 0L
    private var navBackDetectedAt: Long = 0L
    private var lastJsInteractMs: Long = 0L
    // Foreground / recovery loop control
    private var isForeground: Boolean = false
    private var lastRecoveryAttemptAt: Long = 0L
    private var recoveryAttemptsWindowStart: Long = 0L
    private var recoveryAttemptsInWindow: Int = 0
    private var suppressedRecoveryUntil: Long = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        cfgStore = ConfigStore(this)
        cfg = cfgStore.load()

        try { WebView.setWebContentsDebuggingEnabled(true) } catch (_: Throwable) {}

        layoutInflater.inflate(R.layout.webview_container, binding.webContainer, true)
        val webView: WebView = binding.webContainer.findViewById(R.id.webview)
        setupWebView(webView)

        binding.fabSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        navigateToConfiguredUrl()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView(webView: WebView) {
        webView.setBackgroundColor(Color.BLACK)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        webView.settings.cacheMode = WebSettings.LOAD_DEFAULT
        webView.settings.userAgentString = webView.settings.userAgentString + " DashboardAutoReload/1.0"
        webView.settings.loadsImagesAutomatically = true
        webView.settings.databaseEnabled = true
        webView.settings.javaScriptCanOpenWindowsAutomatically = true
        try { CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true) } catch (_: Throwable) {}

        webView.addJavascriptInterface(object {
            @JavascriptInterface
            fun log(msg: String) { try { Log.w("DAR.JS", msg) } catch (_: Throwable) {} }
            @JavascriptInterface
            fun interact() {
                val now = System.currentTimeMillis()
                if (now - lastJsInteractMs >= 800) { // debounce
                    lastJsInteractMs = now
                    lastInteractionMs = now
                }
            }
        }, "Native")

        val progressBar = binding.webContainer.findViewById<android.widget.ProgressBar>(R.id.page_progress)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?): Boolean {
                Log.w(TAG, "onCreateWindow: intercept popup; isDialog=$isDialog userGesture=$isUserGesture")
                val transport = resultMsg?.obj as? WebView.WebViewTransport
                transport?.webView = webView
                resultMsg?.sendToTarget()
                return true
            }
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                try {
                    if (newProgress in 1..99) {
                        if (progressBar.visibility != android.view.View.VISIBLE) progressBar.visibility = android.view.View.VISIBLE
                        progressBar.progress = newProgress
                    } else if (newProgress >= 100) {
                        progressBar.progress = 100
                        progressBar.visibility = android.view.View.GONE
                    }
                } catch (_: Throwable) {}
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                if (url.scheme == "app" && url.host == "settings") {
                    Log.w(TAG, "shouldOverrideUrlLoading: open SettingsActivity")
                    startActivity(Intent(this@MainActivity, SettingsActivity::class.java))
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                Log.w(TAG, "onPageFinished: url=$url")
                super.onPageFinished(view, url)
                try {
                    val u = url ?: ""
                    lastPageUrl = u
                    val isData = u.startsWith("data:")
                    val isAboutBlank = u == "about:blank"
                    val isErrorData = isData && u.contains("Load%20error")
                    val isBlank = isAboutBlank || (isData && !isErrorData)
                    if (!isBlank && !isErrorData) lastGoodUrl = u
                    if ((isBlank || isErrorData) && cfg.url.isNotBlank()) {
                        val now = System.currentTimeMillis()
                        if (!isForeground) {
                            Log.w(TAG, "onPageFinished: blank/error while background; suppress recovery")
                            return
                        }
                        if (now < suppressedRecoveryUntil) {
                            Log.w(TAG, "recovery: suppressed (${suppressedRecoveryUntil - now}ms left)")
                            return
                        }
                        if (recoveryAttemptsWindowStart == 0L || now - recoveryAttemptsWindowStart > 15000L) {
                            recoveryAttemptsWindowStart = now
                            recoveryAttemptsInWindow = 0
                        }
                        if (recoveryAttemptsInWindow >= 4) {
                            suppressedRecoveryUntil = now + 60000L
                            Log.w(TAG, "recovery: too many attempts; pausing 60s")
                            return
                        }
                        if (now - lastRecoveryAttemptAt < 1200L) {
                            Log.w(TAG, "recovery: throttled (<1.2s)")
                            return
                        }
                        recoveryAttemptsInWindow++
                        lastRecoveryAttemptAt = now
                        Log.w(TAG, "onPageFinished: attempting recovery attempt=$recoveryAttemptsInWindow blank=$isBlank errorData=$isErrorData")
                        val wv = view ?: return
                        when {
                            wv.canGoBack() -> {
                                try { wv.goBack(); Log.w(TAG, "recovery: goBack()") } catch (_: Throwable) {}
                            }
                            !lastGoodUrl.isNullOrBlank() -> {
                                try { wv.loadUrl(lastGoodUrl!!); Log.w(TAG, "recovery: load lastGoodUrl=$lastGoodUrl") } catch (_: Throwable) {}
                            }
                            else -> {
                                try { navigateToConfiguredUrl(); Log.w(TAG, "recovery: reload configured URL") } catch (_: Throwable) {}
                            }
                        }
                        return
                    }
                } catch (_: Throwable) {}
                // timers auto-managed by unified loop
                injectLoginScript(view)
                persistSessionIfAvailable(url)
                // Evaluate with the WebView's current URL (may include redirects not yet in lastPageUrl)
                val cur = try { view?.url ?: lastPageUrl } catch (_: Throwable) { lastPageUrl }
                evaluateAutoReloadState(cur)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                val failingUrl = request.url?.toString() ?: ""
                val description = try { error.description?.toString() } catch (_: Throwable) { null }
                Log.w(TAG, "onReceivedError(new): code=${error.errorCode} desc=$description url=$failingUrl")
                try {
                    val looksLikeChallenge =
                        failingUrl.contains("/cdn-cgi/", ignoreCase = true) ||
                        failingUrl.contains("/challenge", ignoreCase = true) ||
                        (description?.contains("Cloudflare", ignoreCase = true) == true)
                    if (looksLikeChallenge) {
                        Log.w(TAG, "onReceivedError: probable challenge; letting WebView render")
                        return
                    }
                    view.loadData(
                        "<html><body style='background:#0b1220;color:#e5e7eb;font-family:sans-serif'><h3>Load error</h3><div>" +
                            (description ?: "") + "</div><div style='margin-top:8px;font-size:12px'>" + failingUrl + "</div></body></html>",
                        "text/html",
                        "utf-8"
                    )
                } catch (_: Throwable) {}
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (request.isForMainFrame) {
                    val code = errorResponse.statusCode
                    val u = request.url.toString()
                    val host = request.url.host ?: ""
                    Log.w(TAG, "onReceivedHttpError: url=$u code=$code")
                    val looksLikeChallenge =
                        code == 403 || code == 429 || code == 503 ||
                        u.contains("/cdn-cgi/", ignoreCase = true) ||
                        u.contains("/challenge", ignoreCase = true) ||
                        host.contains("cloudflare", ignoreCase = true)
                    if (looksLikeChallenge) {
                        Log.w(TAG, "onReceivedHttpError: probable challenge page; letting WebView render it")
                        return
                    }
                    try {
                        val msg = "HTTP ${errorResponse.statusCode} ${errorResponse.reasonPhrase ?: ""}"
                        view.loadData(
                            "<html><body style='background:#0b1220;color:#e5e7eb;font-family:sans-serif'><h3>" + msg + "</h3>" +
                                "</div><div style='margin-top:8px;font-size:12px'>" + request.url + "</div></body></html>",
                            "text/html",
                            "utf-8"
                        )
                    } catch (_: Throwable) {}
                }
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                Log.w(TAG, "onReceivedSslError: primary=${error.primaryError} url=${error.url}; proceeding")
                try { handler.proceed() } catch (_: Throwable) {}
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "onRenderProcessGone: didCrash=${detail.didCrash()} priority=${detail.rendererPriorityAtExit()}")
                try {
                    (view.parent as? android.view.ViewGroup)?.removeView(view)
                } catch (_: Throwable) {}
                val container = findViewById<android.widget.FrameLayout>(R.id.web_container)
                val newWv = WebView(this@MainActivity)
                container.addView(newWv, android.widget.FrameLayout.LayoutParams(android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.MATCH_PARENT))
                setupWebView(newWv)
                navigateToConfiguredUrl()
                return true
            }
        }

        webView.setOnTouchListener { _, _ ->
            val now = System.currentTimeMillis()
            lastInteractionAt = now
            lastInteractionMs = now
            false
        }
    }

    private fun evalJs(view: WebView, script: String, cb: ((String) -> Unit)? = null) {
        try {
            view.evaluateJavascript(script) { res ->
                try { cb?.invoke(res ?: "") } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {}
    }

    private fun normalizedUrl(u: String): String {
        val raw = u
        val t = raw.trim()
        val lower = t.lowercase()
        val out = if (lower.startsWith("http://") || lower.startsWith("https://")) t else "https://$t"
        return out
    }

    private fun computeWindow(startHM: String, duration: String): Pair<Long, Long> {
        fun durationToMs(label: String): Long {
            return when (label) {
                "1h" -> 3600000L
                "2h" -> 7200000L
                "6h" -> 21600000L
                "12h" -> 43200000L
                "1d" -> 86400000L
                "2d" -> 172800000L
                "5d" -> 432000000L
                "7d" -> 604800000L
                else -> {
                    val h = label.filter { it.isDigit() }.toIntOrNull() ?: 24
                    h * 3600000L
                }
            }
        }
        val parts = startHM.split(":")
        val sh = parts.getOrNull(0)?.toIntOrNull()?.coerceIn(0,23) ?: 12
        val sm = parts.getOrNull(1)?.toIntOrNull()?.coerceIn(0,59) ?: 0
        val now = java.util.Calendar.getInstance()
        val start = java.util.Calendar.getInstance().apply {
            set(java.util.Calendar.HOUR_OF_DAY, sh)
            set(java.util.Calendar.MINUTE, sm)
            set(java.util.Calendar.SECOND, 0)
            set(java.util.Calendar.MILLISECOND, 0)
        }
        if (now.before(start)) start.add(java.util.Calendar.DAY_OF_MONTH, -1)
        val from = start.timeInMillis
        val to = from + durationToMs(duration)
        val cur = now.timeInMillis
        return if (cur >= to) {
            val day = 86400000L
            val newFrom = from + day
            Pair(newFrom, newFrom + durationToMs(duration))
        } else Pair(from, to)
    }

    private fun withWindowParams(u: String, from: Long, to: Long): String {
        return try {
            val uri = Uri.parse(u)
            val builder = uri.buildUpon()
            builder.clearQuery()
            val existing = uri.queryParameterNames
            for (name in existing) {
                if (name == "from" || name == "to") continue
                builder.appendQueryParameter(name, uri.getQueryParameter(name))
            }
            builder.appendQueryParameter("from", from.toString())
            builder.appendQueryParameter("to", to.toString())
            val out = builder.build().toString()
            if (uri.getQueryParameter("kiosk") == "") {
                out.replace("kiosk=", "kiosk")
            } else out
        } catch (_: Throwable) { u }
    }

    private fun setSessionCookieIfNeeded(target: String) {
        if (cfg.session.isBlank()) return
        try {
            val targetUrl = normalizedUrl(target)
            val origin = URL(targetUrl)
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setCookie(origin.protocol + "://" + origin.host, "SESSION=${cfg.session}; Path=/; Secure; HttpOnly; SameSite=Lax")
            CookieManager.getInstance().flush()
            Log.w(TAG, "setSessionCookieIfNeeded: set for domain=${origin.host}; length=${cfg.session.length}")
        } catch (_: Throwable) {}
    }

    private fun navigateToConfiguredUrl() {
        val webView: WebView = findViewById(R.id.webview)
        if (cfg.url.isBlank()) {
            Log.w(TAG, "navigateToConfiguredUrl: no URL set; loading placeholder")
            val html = """
                <html><head><meta name=viewport content='width=device-width, initial-scale=1'>
                <style>body{background:#0b1220;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif}button{padding:12px 16px;border-radius:8px;background:#22c55e;border:0;color:#052e14;font-weight:700}</style>
                </head><body><div style='text-align:center'>
                <h2>Settings are missing</h2>
                <p>Please open settings to configure a target URL.</p>
                <button onclick='Native.log("open"); window.location="app://settings"'>Open Settings</button>
                </div></body></html>
            """.trimIndent()
            webView.loadDataWithBaseURL("about:blank", html, "text/html", "utf-8", null)
            return
        }
    // suppress verbose normalized logging; only log final URL once
        val base = normalizedUrl(cfg.url)
        var dest = base
        if (cfg.timeWindow.enabled) {
            val (from, to) = computeWindow(cfg.timeWindow.start, cfg.timeWindow.duration)
            dest = withWindowParams(base, from, to)
        }
        try {
            val uri = Uri.parse(dest)
            Log.w(TAG, "dest diagnostics: scheme=${uri.scheme} host=${uri.host} len=${dest.length}")
        } catch (_: Throwable) {}
        setSessionCookieIfNeeded(base)
        try {
            if (!initialUrlLogged) { Log.w(TAG, "Final URL: $dest"); initialUrlLogged = true }
            webView.loadUrl(dest)
        } catch (e: Throwable) {
            Log.w(TAG, "navigateToConfiguredUrl: loadUrl error: ${e.message}")
        }
    }

    private fun scheduleTimers() {
        scheduledRunnable?.let { mainHandler.removeCallbacks(it) }
        val now = System.currentTimeMillis()
        var earliest = Long.MAX_VALUE
        if (navBackActive && navBackDetectedAt > 0L) {
            val timeoutMs = (cfg.tabTimeoutSec * 1000L).coerceAtLeast(1000L)
            val anchor = if (lastInteractionMs > navBackDetectedAt) lastInteractionMs else navBackDetectedAt
            val fireAt = anchor + timeoutMs
            if (fireAt < earliest) earliest = fireAt
        }
        if (autoReloadActive && reloadFireAt > 0L) {
            if (reloadFireAt < earliest) earliest = reloadFireAt
        }
        if (earliest == Long.MAX_VALUE) { scheduledRunnable = null; return }
        val delay = (earliest - now).coerceAtLeast(50L)
        scheduledRunnable = Runnable { processTimers() }
        mainHandler.postDelayed(scheduledRunnable!!, delay)
    }

    private fun processTimers() {
        val now = System.currentTimeMillis()
        var changed = false
        if (navBackActive && navBackDetectedAt > 0L) {
            val timeoutMs = (cfg.tabTimeoutSec * 1000L).coerceAtLeast(1000L)
            val anchor = if (lastInteractionMs > navBackDetectedAt) lastInteractionMs else navBackDetectedAt
            val fireAt = anchor + timeoutMs
            if (now >= fireAt) {
                val baseCfg = normalizedUrl(cfg.url)
                val (from, to) = if (cfg.timeWindow.enabled) computeWindow(cfg.timeWindow.start, cfg.timeWindow.duration) else Pair(0L,0L)
                val desired = if (cfg.timeWindow.enabled) withWindowParams(baseCfg, from, to) else baseCfg
                navigateBackCycle++
                Log.w(TAG, "navigateBack: fire inactivity cycle=$navigateBackCycle -> $desired")
                try { findViewById<WebView>(R.id.webview).loadUrl(desired) } catch (_: Throwable) {}
                navBackActive = false
                changed = true
            }
        }
        if (autoReloadActive && reloadFireAt > 0L && now >= reloadFireAt && !navBackActive) {
            reloadCount++
            Log.w(TAG, "autoReload: fire count=$reloadCount interval=${cfg.reloadAfterSec}s")
            try { findViewById<WebView>(R.id.webview).reload() } catch (_: Throwable) {}
            val interval = (cfg.reloadAfterSec * 1000).toLong().coerceAtLeast(1000L)
            reloadFireAt = System.currentTimeMillis() + interval
            changed = true
        }
        if (changed) scheduleTimers() else scheduleTimers()
    }

    private fun prepareAutoReload(now: Long) {
        val intervalMs = (cfg.reloadAfterSec * 1000).toLong().coerceAtLeast(1000L)
        reloadFireAt = now + intervalMs
        autoReloadActive = true
        autoReloadRunning = true
        Log.w(TAG, "autoReload: scheduled fireIn=${intervalMs/1000}s")
        scheduleTimers()
    }

    private fun isOnTarget(current: String?): Boolean {
        if (current.isNullOrBlank()) return false
        val baseCfg = normalizedUrl(cfg.url)
        val (from, to) = if (cfg.timeWindow.enabled) computeWindow(cfg.timeWindow.start, cfg.timeWindow.duration) else Pair(0L,0L)
        val desired = if (cfg.timeWindow.enabled) withWindowParams(baseCfg, from, to) else baseCfg
        val curBase = stripFromTo(current)
        val targetBase = stripFromTo(desired)
        return curBase == targetBase && curBase.isNotBlank()
    }

    private fun evaluateAutoReloadState(current: String) {
        val now = System.currentTimeMillis()
        val onTarget = isOnTarget(current)
        if (onTarget) {
            // If we were in a navigateBack cycle and returned, clear it
            if (navBackActive) {
                navBackActive = false
                navBackDetectedAt = 0L
                Log.w(TAG, "navigateBack: returned to target; clearing inactivity monitor")
            }
            // Avoid kicking auto reload while on external login SSO or challenge pages
            val host = try { Uri.parse(current).host ?: "" } catch (_: Throwable) { "" }
            val isAuthHost = host.contains("login.", true) || host.contains("auth", true) || host.contains("challenge", true)
            if (!isAuthHost && cfg.autoReloadEnabled && cfg.reloadAfterSec > 0 && !autoReloadActive) {
                prepareAutoReload(now)
            }
        } else {
            // Off target. Disable any running auto reload and arm navigateBack if enabled.
            if (autoReloadActive || autoReloadRunning) {
                autoReloadActive = false
                autoReloadRunning = false
                reloadFireAt = 0L
                Log.w(TAG, "autoReload: suspended (off target)")
            }
            if (cfg.navigateBackEnabled) {
                val host = try { Uri.parse(current).host ?: "" } catch (_: Throwable) { "" }
                val isAuthHost = host.contains("login.", true) || host.contains("auth", true) || host.contains("challenge", true)
                if (isAuthHost) {
                    // Defer navigateBack while in auth flows; user/JS needs to complete login.
                    navBackActive = false
                } else {
                    if (!navBackActive) {
                        navBackActive = true
                        navBackDetectedAt = now
                        Log.w(TAG, "navigateBack: divergence detected inactivity=${cfg.tabTimeoutSec}s current=$current")
                    } else if (now - navBackDetectedAt > 2000) {
                        navBackDetectedAt = now
                    }
                }
            } else navBackActive = false
        }
        // Recompute timers whenever state changes
        scheduleTimers()
    }

        // end evaluateAutoReloadState
    // (no closing brace here; keep class open)

    private fun injectLoginScript(webView: WebView?) {
        if (webView == null) return
        val email = cfg.user.email
        val pass = cfg.user.password
        val twoFAEnabled = cfg.twoFAEnabled
        val has2FA = cfgStore.hasTwoFA()
        if (email.isBlank() && pass.isBlank() && !(twoFAEnabled && has2FA)) return
        val totp = if (twoFAEnabled && has2FA) cfgStore.getTOTPCode() else ""
        val script = """
            (function(){
                try{
                    if (window.__DAR_LOGIN_INIT) { try{Native.log('auto:skip-duplicate');}catch(e){}; return; }
                    window.__DAR_LOGIN_INIT = true;
                    const EMAIL=${toJsString(email)}; const PASS=${toJsString(pass)}; const USE_2FA=${toJsBool(twoFAEnabled && has2FA)}; const TOTP=${toJsString(totp)};
                    try{ Native.log('auto:init emailLen=' + EMAIL.length + ' passSet=' + (PASS.length>0) + ' use2FA=' + USE_2FA);}catch(e){}
                    const emailSel=['#username','input[name="loginfmt"]','input[type="email"]','input[name="username"]'];
                    const passSel=['input[name="passwd"]','input[type="password"]','#password'];
                    const twoFASel=['input#code','input[name="code"]','input[autocomplete="one-time-code"]'];
                    function findAny(ars){ for(const s of ars){ const el=document.querySelector(s); if(el) return el; } return null; }
                    function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
                    async function runOnce(){
                        // removed verbose run log
                        const emailEl=findAny(emailSel);
                        if(emailEl && EMAIL){
                            if(emailEl.value!==EMAIL){ emailEl.focus(); emailEl.value=''; emailEl.dispatchEvent(new Event('input',{bubbles:true})); emailEl.value=EMAIL; emailEl.dispatchEvent(new Event('input',{bubbles:true})); try{Native.log('auto:filled-email');}catch(e){} }
                        }
                        let tries=0; while(!findAny(passSel) && tries<20){ await sleep(200); tries++; }
                        const passEl=findAny(passSel);
                        if(passEl && PASS){
                            passEl.focus(); passEl.value=''; passEl.dispatchEvent(new Event('input',{bubbles:true}));
                            passEl.value=PASS; passEl.dispatchEvent(new Event('input',{bubbles:true})); try{Native.log('auto:filled-pass');}catch(e){}
                        }
                        const codeEl=findAny(twoFASel); if(codeEl && USE_2FA && TOTP!==''){
                            codeEl.focus(); codeEl.value=''; codeEl.dispatchEvent(new Event('input',{bubbles:true}));
                            codeEl.value=TOTP; codeEl.dispatchEvent(new Event('input',{bubbles:true})); try{Native.log('auto:filled-totp');}catch(e){}
                        }
                        return !!(emailEl||passEl||codeEl);
                    }
                    let ticks=0; const max=120; // ~60s
                    (function loop(){ runOnce().catch(()=>{}).finally(()=>{ ticks++; if(ticks<max) setTimeout(loop, 500); }); })();
                    window.addEventListener('hashchange', ()=>{ try{Native.log('auto:hashchange');}catch(e){}; ticks=0; });
                    window.addEventListener('popstate', ()=>{ try{Native.log('auto:popstate');}catch(e){}; ticks=0; });
                    try {
                        ['click','keydown','touchstart','mousemove','scroll'].forEach(evt=>{
                            window.addEventListener(evt, ()=>{ try{Native.interact();}catch(e){} }, {passive:true});
                        });
                    } catch(e) { try{Native.log('auto:listener-error '+e.message);}catch(_){} }
                }catch(e){ try{Native.log('auto:bootstrap-error '+(e&&e.message));}catch(_){} }
            })();
        """.trimIndent()
        evalJs(webView, script, null)
    }

    private fun toJsString(s: String): String {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    }

    private fun toJsBool(b: Boolean): String = if (b) "true" else "false"

    override fun onResume() {
        super.onResume()
        isForeground = true
        val now = System.currentTimeMillis()
        if (now > suppressedRecoveryUntil) {
            recoveryAttemptsInWindow = 0
            recoveryAttemptsWindowStart = 0L
        }
        cfg = cfgStore.load()
    try { Log.w(TAG, "onResume: cfg.url='${cfg.url}', reloadAfter=${cfg.reloadAfterSec}, autoReload=${cfg.autoReloadEnabled}") } catch (_: Throwable) {}
        navigateToConfiguredUrl()
    startWatchdog()
    startNavigateBackMonitor()
    // Initialize auto reload state based on current page (may already be on target)
    try { findViewById<WebView>(R.id.webview)?.let { evaluateAutoReloadState(it.url ?: "") } } catch (_: Throwable) {}
    // Touch listener already set in setupWebView; no duplicate here
    }

    override fun onPause() {
        super.onPause()
        isForeground = false
    }

    private var watchdogRunnable: Runnable? = null
    private fun startWatchdog() {
        watchdogRunnable?.let { mainHandler.removeCallbacks(it) }
        val webView: WebView = findViewById(R.id.webview)
        watchdogRunnable = object : Runnable {
            override fun run() {
                try {
                    val current = webView.url ?: ""
                    if (cfg.timeWindow.enabled) {
                        // Only enforce window params when we're on the target host (avoid fighting SSO/login redirects)
                        val targetBase = normalizedUrl(cfg.url)
                        val targetHost = try { Uri.parse(targetBase).host } catch (_: Throwable) { null }
                        val curHost = try { Uri.parse(current).host } catch (_: Throwable) { null }
                        if (targetHost != null && curHost != null) {
                            val sameHost = curHost == targetHost || curHost.endsWith(".$targetHost")
                            if (!sameHost) {
                                // Skip adjustment; will retry later after auth flow lands on target
                                mainHandler.postDelayed(this, 5000)
                                return
                            }
                        }
                        val baseCfg = normalizedUrl(cfg.url)
                        val (from, to) = computeWindow(cfg.timeWindow.start, cfg.timeWindow.duration)
                        val desired = withWindowParams(baseCfg, from, to)
                        val uri = Uri.parse(current)
                        val curFrom = uri.getQueryParameter("from")?.toLongOrNull() ?: 0L
                        val curTo = uri.getQueryParameter("to")?.toLongOrNull() ?: 0L
                        if (kotlin.math.abs(curFrom - from) > 5000 || kotlin.math.abs(curTo - to) > 5000) {
                            webView.loadUrl(desired)
                        }
                    }
                } catch (_: Throwable) {}
                mainHandler.postDelayed(this, 5000)
            }
        }
        mainHandler.postDelayed(watchdogRunnable!!, 5000)
    }

    private fun startNavigateBackMonitor() {
        if (!cfg.navigateBackEnabled) { navBackActive = false; return }
        lastNavBackIntervalSec = cfg.tabTimeoutSec.coerceAtLeast(1)
        val webView: WebView = findViewById(R.id.webview)
        val current = webView.url ?: ""
        lastPageUrl = current
        val baseCfg = normalizedUrl(cfg.url)
        val (from, to) = if (cfg.timeWindow.enabled) computeWindow(cfg.timeWindow.start, cfg.timeWindow.duration) else Pair(0L,0L)
        val desired = if (cfg.timeWindow.enabled) withWindowParams(baseCfg, from, to) else baseCfg
        val curBase = stripFromTo(current)
        val targetBase = stripFromTo(desired)
        if (curBase.isNotEmpty() && targetBase.isNotEmpty() && curBase != targetBase) {
            if (!navBackActive) {
                navBackActive = true
                navBackDetectedAt = System.currentTimeMillis()
                Log.w(TAG, "navigateBack: divergence detected (resume) inactivity=${cfg.tabTimeoutSec}s current=$curBase target=$targetBase")
                autoReloadActive = false
                autoReloadRunning = false
            }
        } else navBackActive = false
    scheduleTimers()
    evaluateAutoReloadState(current)
    }

    private fun stripFromTo(u: String): String {
        return try {
            val uri = Uri.parse(u)
            Uri.parse(uri.buildUpon().clearQuery().build().toString()).buildUpon().apply {
                for (p in uri.queryParameterNames) {
                    if (p == "from" || p == "to") continue
                    appendQueryParameter(p, uri.getQueryParameter(p))
                }
            }.build().toString()
        } catch (_: Throwable) { u }
    }

    private fun persistSessionIfAvailable(url: String?) {
        try {
            val current = url ?: return
            val target = normalizedUrl(cfg.url)
            if (target.isBlank()) return
            val curHost = Uri.parse(current).host ?: return
            val tgtHost = Uri.parse(target).host ?: return
            val isSame = curHost == tgtHost || curHost.endsWith(".$tgtHost")
            if (!isSame) return
            val cm = CookieManager.getInstance()
            val cookieStr = cm.getCookie(Uri.parse(target).buildUpon().scheme("https").authority(tgtHost).build().toString()) ?: return
            val parts = cookieStr.split(";")
            val sess = parts.firstOrNull { it.trim().startsWith("SESSION=") }?.trim()?.removePrefix("SESSION=") ?: return
            if (sess.isNotBlank() && sess != cfg.session) {
                val updated = cfg.copy(session = sess)
                cfgStore.save(updated)
                cfg = updated
            }
        } catch (_: Throwable) {}
    }
}
