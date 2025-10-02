package com.ankitseal.dashboardautoreload

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        cfgStore = ConfigStore(this)
        cfg = cfgStore.load()

    // Inflate the WebView into the container and set up behaviors
    layoutInflater.inflate(R.layout.webview_container, binding.webContainer, true)
    setupWebView(binding.webContainer.findViewById(R.id.webview))

        binding.fabSettings.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        // Initial load
        navigateToConfiguredUrl()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView(webView: WebView) {
        webView.setBackgroundColor(Color.BLACK)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        webView.settings.cacheMode = WebSettings.LOAD_DEFAULT
        webView.settings.userAgentString = webView.settings.userAgentString + " DashboardAutoReload/1.0"

        webView.webChromeClient = object : WebChromeClient() {}
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                // Intercept internal settings link
                if (url.scheme == "app" && url.host == "settings") {
                    startActivity(Intent(this@MainActivity, SettingsActivity::class.java))
                    return true
                }
                return false // load in this WebView
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                maybeStartTimers(view)
                injectLoginScript(view)
            }
        }

        webView.addJavascriptInterface(object {
            @JavascriptInterface
            fun log(msg: String) {}
        }, "Native")
    }

    private fun normalizedUrl(u: String): String {
        return if (u.matches(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:"))) u else "https://$u"
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
            // restore bare kiosk if present
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
        } catch (_: Throwable) {}
    }

    private fun navigateToConfiguredUrl() {
        val webView = findViewById<WebView>(R.id.webview)
        val hasUrl = cfg.url.isNotBlank()
        if (!hasUrl) {
            // Load a local placeholder similar to missing.html
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
        val base = normalizedUrl(cfg.url)
        var dest = base
        if (cfg.timeWindow.enabled) {
            val (from, to) = computeWindow(cfg.timeWindow.start, cfg.timeWindow.duration)
            dest = withWindowParams(base, from, to)
        }
        setSessionCookieIfNeeded(base)
        webView.loadUrl(dest)
    }

    private fun scheduleBehaviors() {
        // Keep-alive
        keepAliveTimer?.cancel(); keepAliveTimer = null
        if (cfg.keepAliveSec > 0) {
            val url = findViewById<WebView>(R.id.webview).url ?: return
            keepAliveTimer = Timer().apply {
                schedule(object : TimerTask() {
                    override fun run() {
                        mainHandler.post {
                            val u = Uri.parse(url).buildUpon().appendQueryParameter("_ka", System.currentTimeMillis().toString()).build().toString()
                            val js = "(function(){try{fetch('" + u.replace("\\", "\\\\").replace("'","\\'") + "', {method:'HEAD', credentials:'include', cache:'no-store', redirect:'manual'}).catch(function(){});}catch(e){}})();"
                            findViewById<WebView>(R.id.webview).evaluateJavascript(js, null)
                        }
                    }
                }, (cfg.keepAliveSec * 1000).toLong(), (cfg.keepAliveSec * 1000).toLong())
            }
        }
        // Auto-reload
        reloadRunnable?.let { mainHandler.removeCallbacks(it) }
        if (cfg.autoReloadEnabled && cfg.reloadAfterSec > 0) {
            reloadRunnable = Runnable { findViewById<WebView>(R.id.webview).reload() }
            mainHandler.postDelayed(reloadRunnable!!, (cfg.reloadAfterSec * 1000).toLong())
        }
    }

    private fun maybeStartTimers(webView: WebView?) {
        if (webView == null) return
        val selector = cfg.waitForCss
        if (selector.isNullOrBlank()) {
            scheduleBehaviors()
            return
        }
        // Poll for selector for up to 20s then schedule
        val deadline = System.currentTimeMillis() + 20000
        fun poll() {
            if (System.currentTimeMillis() > deadline) { scheduleBehaviors(); return }
            webView.evaluateJavascript("(function(){return !!document.querySelector('" + selector.replace("\\","\\\\").replace("'","\\'") + "')})()") { res ->
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
        if (email.isBlank() && pass.isBlank()) return
        val script = """
            (function(){
              const emailSel=['#username','input[name="loginfmt"]','input[type="email"]','input[name="username"]'];
              const nextSel=['button._button-login-id','#idSIButton9','input[type="submit"]','button[type="submit"]'];
              const passSel=['input[name="passwd"]','input[type="password"]','#password'];
              function findAny(ars){ for(const s of ars){ const el=document.querySelector(s); if(el) return el; } return null; }
              function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
              async function waitForCaptcha(ms=90000){ const start=Date.now(); while(Date.now()-start<ms){ const t=document.querySelector('input[name="cf-turnstile-response"], textarea#g-recaptcha-response'); if(t && t.value) return true; await sleep(300);} return false; }
              (async function(){
                const emailEl=findAny(emailSel); if(emailEl){
                  emailEl.focus(); emailEl.value=''; emailEl.dispatchEvent(new Event('input',{bubbles:true}));
                  emailEl.value=${toJsString(email)}; emailEl.dispatchEvent(new Event('input',{bubbles:true}));
                  try{ await waitForCaptcha(90000);}catch(e){}
                  const next=findAny(nextSel); if(next) next.click();
                }
                let tries=0; while(!findAny(passSel) && tries<200){ await sleep(100); tries++; }
                const passEl=findAny(passSel); if(passEl){
                  passEl.focus(); passEl.value=''; passEl.dispatchEvent(new Event('input',{bubbles:true}));
                  passEl.value=${toJsString(pass)}; passEl.dispatchEvent(new Event('input',{bubbles:true}));
                  const next2=findAny(['#idSIButton9','button[type="submit"]','input[type="submit"]']); if(next2) next2.click();
                }
              })();
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
    }

    private fun toJsString(s: String): String {
        // JSON.stringify-like quoting for embedding
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    }

    override fun onResume() {
        super.onResume()
        cfg = cfgStore.load()
        navigateToConfiguredUrl()
        startWatchdog()
    }

    // Watchdog to keep URL aligned (navigate-back and rolling window drift)
    private var watchdogRunnable: Runnable? = null
    private fun startWatchdog() {
        watchdogRunnable?.let { mainHandler.removeCallbacks(it) }
        val webView = findViewById<WebView>(R.id.webview)
        watchdogRunnable = object : Runnable {
            override fun run() {
                try {
                    val current = webView.url ?: ""
                    val baseCfg = normalizedUrl(cfg.url)
                    val (from, to) = if (cfg.timeWindow.enabled) computeWindow(cfg.timeWindow.start, cfg.timeWindow.duration) else Pair(0L, 0L)
                    val desired = if (cfg.timeWindow.enabled) withWindowParams(baseCfg, from, to) else baseCfg
                    // If navigateBack is enabled and bases differ, navigate back
                    if (cfg.navigateBackEnabled) {
                        val curBase = stripFromTo(current)
                        val targetBase = stripFromTo(desired)
                        if (curBase.isNotEmpty() && targetBase.isNotEmpty() && curBase != targetBase) {
                            webView.loadUrl(desired)
                            mainHandler.postDelayed(this, 60000)
                            return
                        }
                    }
                    // If rolling window enabled, ensure from/to match within 5s
                    if (cfg.timeWindow.enabled) {
                        val uri = Uri.parse(current)
                        val curFrom = uri.getQueryParameter("from")?.toLongOrNull() ?: 0L
                        val curTo = uri.getQueryParameter("to")?.toLongOrNull() ?: 0L
                        if (kotlin.math.abs(curFrom - from) > 5000 || kotlin.math.abs(curTo - to) > 5000) {
                            webView.loadUrl(desired)
                        }
                    }
                } catch (_: Throwable) {}
                mainHandler.postDelayed(this, 60000)
            }
        }
        mainHandler.postDelayed(watchdogRunnable!!, 60000)
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
}
