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
import android.net.http.SslError
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import com.ankitseal.dashboardautoreload.databinding.ActivityMainBinding
import java.net.URL
import java.util.Timer
import java.util.TimerTask

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var cfgStore: ConfigStore
    private var cfg: ConfigStore.Config = ConfigStore.Config()

    private val mainHandler = Handler(Looper.getMainLooper())
    private var keepAliveTimer: Timer? = null
    private var reloadRunnable: Runnable? = null
    private val TAG = "DAR.MainActivity"
    private var lastGoodUrl: String? = null

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
            fun log(msg: String) {
                try { Log.w("DAR.JS", msg) } catch (_: Throwable) {}
            }
        }, "Native")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message?): Boolean {
                Log.w(TAG, "onCreateWindow: intercept popup; isDialog=$isDialog userGesture=$isUserGesture")
                val transport = resultMsg?.obj as? WebView.WebViewTransport
                transport?.webView = webView
                resultMsg?.sendToTarget()
                return true
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
                    val isBlank = u == "about:blank" || u.startsWith("data:")
                    if (!isBlank) lastGoodUrl = u
                    if (isBlank && cfg.url.isNotBlank()) {
                        Log.w(TAG, "onPageFinished: landed on blank (u='$u'), attempting recovery")
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
                maybeStartTimers(view)
                injectLoginScript(view)
                persistSessionIfAvailable(url)
            }

            override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) {
                Log.w(TAG, "onReceivedError: code=$errorCode desc=$description url=$failingUrl")
                try {
                    val u = failingUrl ?: ""
                    val looksLikeChallenge =
                        u.contains("/cdn-cgi/", ignoreCase = true) ||
                        u.contains("/challenge", ignoreCase = true) ||
                        (description?.contains("Cloudflare", ignoreCase = true) == true)
                    if (looksLikeChallenge) {
                        Log.w(TAG, "onReceivedError: probable challenge; not replacing content")
                        return
                    }
                    val isMain = (view.url == null) || (view.url == u)
                    if (!isMain) return
                    view.loadData(
                        "<html><body style='background:#0b1220;color:#e5e7eb;font-family:sans-serif'><h3>Load error</h3><div>" +
                            (description ?: "") + "</div><div style='margin-top:8px;font-size:12px'>" + u + "</div></body></html>",
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
        try {
            val previewIn = t.take(80)
            val previewOut = out.take(80)
            Log.w(TAG, "normalizedUrl: lenIn=${t.length} -> lenOut=${out.length}; '$previewIn' -> '$previewOut'")
        } catch (_: Throwable) {}
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
        Log.w(TAG, "navigateToConfiguredUrl: start url='${cfg.url}'")
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
            Log.w(TAG, "navigateToConfiguredUrl: loading '$dest'")
            webView.loadUrl(dest)
        } catch (e: Throwable) {
            Log.w(TAG, "navigateToConfiguredUrl: loadUrl error: ${e.message}")
        }
    }

    private fun scheduleBehaviors() {
        keepAliveTimer?.cancel(); keepAliveTimer = null
        if (cfg.keepAliveSec > 0) {
            Log.w(TAG, "schedule: keepAlive every ${cfg.keepAliveSec}s")
            val url = findViewById<WebView>(R.id.webview).url ?: return
            keepAliveTimer = Timer().apply {
                schedule(object : TimerTask() {
                    override fun run() {
                        mainHandler.post {
                            val u = Uri.parse(url).buildUpon().appendQueryParameter("_ka", System.currentTimeMillis().toString()).build().toString()
                            val js = "(function(){try{fetch('" + u.replace("\\", "\\\\").replace("'","\\'") + "', {method:'HEAD', credentials:'include', cache:'no-store', redirect:'manual'}).catch(function(){});}catch(e){}})();"
                            evalJs(findViewById(R.id.webview), js, null)
                        }
                    }
                }, (cfg.keepAliveSec * 1000).toLong(), (cfg.keepAliveSec * 1000).toLong())
            }
        }
        reloadRunnable?.let { mainHandler.removeCallbacks(it) }
        if (cfg.autoReloadEnabled && cfg.reloadAfterSec > 0) {
            reloadRunnable = Runnable { findViewById<WebView>(R.id.webview).reload() }
            mainHandler.postDelayed(reloadRunnable!!, (cfg.reloadAfterSec * 1000).toLong())
            Log.w(TAG, "schedule: autoReload after ${cfg.reloadAfterSec}s")
        }
    }

    private fun maybeStartTimers(webView: WebView?) {
        if (webView == null) return
        val selector = cfg.waitForCss
        if (selector.isNullOrBlank()) {
            scheduleBehaviors()
            return
        }
        val deadline = System.currentTimeMillis() + 20000
        fun poll() {
            if (System.currentTimeMillis() > deadline) { scheduleBehaviors(); return }
            evalJs(webView, "(function(){return !!document.querySelector('" + selector.replace("\\","\\\\").replace("'","\\'") + "')})()") { res ->
                val ok = res == "true"
                if (ok) scheduleBehaviors() else mainHandler.postDelayed({ poll() }, 300)
            }
        }
        poll()
    }

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
                        try{ Native.log('auto:run'); }catch(e){}
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
        cfg = cfgStore.load()
        try { Log.w(TAG, "onResume: cfg.url='${cfg.url}', reloadAfter=${cfg.reloadAfterSec}, autoReload=${cfg.autoReloadEnabled}") } catch (_: Throwable) {}
        navigateToConfiguredUrl()
        startWatchdog()
    }

    private var watchdogRunnable: Runnable? = null
    private fun startWatchdog() {
        watchdogRunnable?.let { mainHandler.removeCallbacks(it) }
        val webView: WebView = findViewById(R.id.webview)
        watchdogRunnable = object : Runnable {
            override fun run() {
                try {
                    val current = webView.url ?: ""
                    val baseCfg = normalizedUrl(cfg.url)
                    val (from, to) = if (cfg.timeWindow.enabled) computeWindow(cfg.timeWindow.start, cfg.timeWindow.duration) else Pair(0L, 0L)
                    val desired = if (cfg.timeWindow.enabled) withWindowParams(baseCfg, from, to) else baseCfg
                    if (cfg.navigateBackEnabled) {
                        val curBase = stripFromTo(current)
                        val targetBase = stripFromTo(desired)
                        if (curBase.isNotEmpty() && targetBase.isNotEmpty() && curBase != targetBase) {
                            webView.loadUrl(desired)
                            mainHandler.postDelayed(this, 5000)
                            return
                        }
                    }
                    if (cfg.timeWindow.enabled) {
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
