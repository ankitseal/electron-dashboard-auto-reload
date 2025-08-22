package com.ankitseal.dashboardautoreload

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Button
import android.widget.Toast
import com.google.android.material.materialswitch.MaterialSwitch
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.textfield.TextInputLayout

class SettingsActivity : AppCompatActivity() {
    private lateinit var store: ConfigStore
    private val TAG = "DAR.Settings"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        // Defer heavier config load & view wiring until after first frame to reduce SurfaceSyncGroup timeout risk
        window.decorView.post { initializeSettingsUI() }
    }

    private fun initializeSettingsUI() {
        if (isFinishing || isDestroyed) return
        store = ConfigStore(this)
        val cfg = store.load()

        // Populate fields
        findViewById<EditText>(R.id.et_url).setText(cfg.url)
        val sessionEt = findViewById<EditText>(R.id.et_session)
        sessionEt.setText(cfg.session)
        sessionEt.isEnabled = false
        sessionEt.isFocusable = false
        findViewById<EditText>(R.id.et_email).setText(cfg.user.email)
        findViewById<EditText>(R.id.et_password).setText(cfg.user.password)
        findViewById<EditText>(R.id.et_reload).setText(cfg.reloadAfterSec.toString())
        findViewById<MaterialSwitch>(R.id.cb_auto).isChecked = cfg.autoReloadEnabled
        findViewById<EditText>(R.id.et_twstart).setText(cfg.timeWindow.start)
        findViewById<EditText>(R.id.et_twdur).setText(cfg.timeWindow.duration)
        val twSwitch = findViewById<MaterialSwitch>(R.id.cb_twenabled)
        twSwitch.isChecked = cfg.timeWindow.enabled
        findViewById<MaterialSwitch>(R.id.cb_navback).isChecked = cfg.navigateBackEnabled
        findViewById<EditText>(R.id.et_tabto).setText(cfg.tabTimeoutSec.toString())
        findViewById<MaterialSwitch>(R.id.cb_twofa).isChecked = cfg.twoFAEnabled
        findViewById<EditText>(R.id.et_twofa).isEnabled = true

        // Dynamic enable/disable for dependent numeric fields
        fun updateFieldStates() {
            val autoSwitch = findViewById<MaterialSwitch>(R.id.cb_auto)
            val navSwitch = findViewById<MaterialSwitch>(R.id.cb_navback)
            val reloadEt = findViewById<EditText>(R.id.et_reload)
            val tabEt = findViewById<EditText>(R.id.et_tabto)
            val autoOn = autoSwitch.isChecked
            val navOn = navSwitch.isChecked
            reloadEt.isEnabled = autoOn
            tabEt.isEnabled = navOn
            if (autoOn) {
                val v = reloadEt.text.toString().trim().toIntOrNull() ?: 0
                if (v <= 0) reloadEt.setText("60")
            }
            if (navOn) {
                val v = tabEt.text.toString().trim().toIntOrNull() ?: 0
                if (v <= 0) tabEt.setText("600")
            }
        }
        findViewById<MaterialSwitch>(R.id.cb_auto).setOnCheckedChangeListener { _, _ -> updateFieldStates() }
        findViewById<MaterialSwitch>(R.id.cb_navback).setOnCheckedChangeListener { _, _ -> updateFieldStates() }
        updateFieldStates()

        // Rolling window dynamic UI
        val twStartEt = findViewById<EditText>(R.id.et_twstart)
        val twDurEt = findViewById<EditText>(R.id.et_twdur)
        fun applyTwState() {
            val en = twSwitch.isChecked
            val vis = if (en) android.view.View.VISIBLE else android.view.View.GONE
            listOf(
                findViewById<TextView>(R.id.tv_twstart_label),
                findViewById<TextView>(R.id.tv_twdur_label),
                findViewById<android.view.View>(R.id.layout_twstart),
                findViewById<android.view.View>(R.id.layout_twdur),
                twStartEt,
                twDurEt
            ).forEach { it.visibility = vis }
        }
        twSwitch.setOnCheckedChangeListener { _, _ -> applyTwState() }
        applyTwState()

        // Time picker (24h) on twStartEt
        twStartEt.setOnClickListener {
            val cur = twStartEt.text.toString().split(":")
            val h = cur.getOrNull(0)?.toIntOrNull() ?: 12
            val m = cur.getOrNull(1)?.toIntOrNull() ?: 0
            val dlg = android.app.TimePickerDialog(this, { _, hh, mm ->
                twStartEt.setText(String.format("%02d:%02d", hh, mm))
            }, h, m, true)
            dlg.show()
        }

        // Duration dropdown via simple dialog
        val durations = arrayOf("1h","2h","6h","12h","1d","2d","5d","7d")
        twDurEt.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle("Select duration")
                .setItems(durations) { d, which ->
                    twDurEt.setText(durations[which])
                    d.dismiss()
                }
                .show()
        }

        // Toolbar save action
        val toolbar = findViewById<com.google.android.material.appbar.MaterialToolbar>(R.id.toolbar_settings)
        toolbar.inflateMenu(R.menu.menu_settings)
        toolbar.setOnMenuItemClickListener { item ->
            if (item.itemId == R.id.action_save) {
                performSave(); true
            } else false
        }

        // 2FA register button
        findViewById<Button>(R.id.btn_twofa_register).setOnClickListener {
            val secret = findViewById<EditText>(R.id.et_twofa).text.toString().trim()
            if (secret.isBlank()) {
                Toast.makeText(this, "Secret required", Toast.LENGTH_SHORT).show()
            } else {
                store.registerTwoFA(secret)
                findViewById<EditText>(R.id.et_twofa).setText("")
                findViewById<MaterialSwitch>(R.id.cb_twofa).isChecked = true
                Toast.makeText(this, "2FA key registered", Toast.LENGTH_SHORT).show()
                syncTwoFASection()
            }
        }
        // 2FA remove button
        findViewById<Button>(R.id.btn_twofa_remove).setOnClickListener {
            store.removeTwoFASecret()
            syncTwoFASection()
        }

        // Build 2FA section (now in same delayed phase)
        syncTwoFASection()
    }

    private fun performSave() {
        val urlEt = findViewById<EditText>(R.id.et_url)
        val emailEt = findViewById<EditText>(R.id.et_email)
        val passEt = findViewById<EditText>(R.id.et_password)
        val reloadEt = findViewById<EditText>(R.id.et_reload)
        val tabTimeoutEt = findViewById<EditText>(R.id.et_tabto)
        val twStartEt = findViewById<EditText>(R.id.et_twstart)
        val twDurEt = findViewById<EditText>(R.id.et_twdur)

        // Basic required validation
        var hasError = false
        fun parentLayout(et: EditText): TextInputLayout? = (et.parent?.parent as? TextInputLayout)
        fun setErr(et: EditText, msg: String?) {
            val til = parentLayout(et)
            if (til != null) til.error = msg else et.error = msg
        }
        fun clearErr(et: EditText) = setErr(et, null)
        fun req(et: EditText, name: String, minLen: Int = 1) {
            if (et.text.toString().trim().length < minLen) {
                setErr(et, "$name required"); hasError = true
            } else clearErr(et)
        }
        fun reqPositive(et: EditText, name: String) {
            val n = et.text.toString().trim().toIntOrNull()
            if (n == null || n <= 0) { setErr(et, "$name must be > 0"); hasError = true } else clearErr(et)
        }
        req(urlEt, "URL")
        // email/password optional; only validate reload & tab timeout when enabled
        val autoOn = findViewById<MaterialSwitch>(R.id.cb_auto).isChecked
        val navOn = findViewById<MaterialSwitch>(R.id.cb_navback).isChecked
        if (autoOn) { req(reloadEt, "Reload"); reqPositive(reloadEt, "Reload") }
        if (navOn) { req(tabTimeoutEt, "Inactivity"); reqPositive(tabTimeoutEt, "Inactivity") }
        val twOn = findViewById<MaterialSwitch>(R.id.cb_twenabled).isChecked
        if (twOn) {
            req(twStartEt, "Start")
            req(twDurEt, "Duration")
        }
        if (hasError) {
            Toast.makeText(this, "Fix highlighted fields", Toast.LENGTH_SHORT).show()
            return
        }

        val cfgOld = store.load()
        val oldUrl = cfgOld.url.trim()
        val urlStrRaw = urlEt.text.toString()
        val urlStr = urlStrRaw.trim()
        val session = cfgOld.session // session field disabled & auto-managed

        val newCfg = ConfigStore.Config(
            url = urlStr,
            session = session,
            reloadAfterSec = reloadEt.text.toString().toIntOrNull() ?: 0,
            user = ConfigStore.User(
                email = emailEt.text.toString(),
                password = passEt.text.toString()
            ),
            timeWindow = ConfigStore.TimeWindow(
                enabled = twOn,
                start = twStartEt.text.toString().ifBlank { "12:00" },
                duration = twDurEt.text.toString().ifBlank { "1d" }
            ),
            autoReloadEnabled = autoOn,
            navigateBackEnabled = navOn,
            tabTimeoutSec = tabTimeoutEt.text.toString().toIntOrNull() ?: 0,
            twoFAEnabled = findViewById<MaterialSwitch>(R.id.cb_twofa).isChecked,
            hasTwoFASecret = store.hasTwoFA()
        )
        if (newCfg.timeWindow.enabled && newCfg.autoReloadEnabled) {
            val durSec = when (newCfg.timeWindow.duration) {
                "1h"->3600;"2h"->7200;"6h"->21600;"12h"->43200;"1d"->86400;"2d"->172800;"5d"->432000;"7d"->604800
                else -> newCfg.timeWindow.duration.filter { it.isDigit() }.toIntOrNull()?.times(3600) ?: 86400
            }
            if (newCfg.reloadAfterSec >= durSec) newCfg.reloadAfterSec = (durSec - 1).coerceAtLeast(1)
        }
    // Already validated >0 when enabled; no silent correction

        val urlChanged = oldUrl.isNotBlank() && oldUrl != newCfg.url && newCfg.url.isNotBlank()
        if (urlChanged) {
            newCfg.session = ""
            try {
                val webviewDir = getDir("app_webview", Context.MODE_PRIVATE)
                webviewDir.deleteRecursively()
                android.webkit.WebStorage.getInstance().deleteAllData()
                android.webkit.CookieManager.getInstance().removeAllCookies(null)
                android.webkit.CookieManager.getInstance().flush()
                Log.w(TAG, "urlChanged: cleared webview data & session")
            } catch (_: Throwable) {}
        }
        store.save(newCfg)
        Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        finish()
    }

    private var totpHandler: Handler? = null
    private var totpRunnable: Runnable? = null
    private var cachedTotpSecret: String? = null
    private var lastTotpRenderedSecond: Int = -1

    private fun syncTwoFASection() {
        val hasSecret = store.hasTwoFA()
        val enabled = store.load().twoFAEnabled
    // reduced logging
        // Controls
        val label = findViewById<TextView>(R.id.tv_twofa_secret_label)
        val input = findViewById<EditText>(R.id.et_twofa)
        val regBtn = findViewById<Button>(R.id.btn_twofa_register)
        val rmBtn = findViewById<Button>(R.id.btn_twofa_remove)
        val status = findViewById<TextView>(R.id.tv_twofa_status)
        val codeLabel = findViewById<TextView>(R.id.tv_totp_label)
        val row = findViewById<LinearLayout>(R.id.totp_row)
        val codeView = findViewById<TextView>(R.id.tv_totp_code)
        val ring = findViewById<com.google.android.material.progressindicator.CircularProgressIndicator>(R.id.totp_ring)

        // Toggle visibility depending on registration
        status.visibility = if (hasSecret) TextView.VISIBLE else TextView.GONE
        label.visibility = if (hasSecret) TextView.GONE else TextView.VISIBLE
        input.visibility = if (hasSecret) EditText.GONE else EditText.VISIBLE
        regBtn.visibility = if (hasSecret) Button.GONE else Button.VISIBLE
        rmBtn.isEnabled = hasSecret

        // Inline TOTP preview when registered and feature enabled
        val showPreview = hasSecret && enabled
        codeLabel.visibility = if (showPreview) TextView.VISIBLE else TextView.GONE
        row.visibility = if (showPreview) LinearLayout.VISIBLE else LinearLayout.GONE

        // Tap-to-copy (only when activity in foreground focus). Use safe check to suppress system log spam
        codeView.setOnClickListener {
            if (!hasWindowFocus()) return@setOnClickListener
            try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val code = codeView.text.toString().replace(" ", "")
                if (code.length >= 4) { // basic sanity
                    val clip = ClipData.newPlainText("TOTP", code)
                    cm.setPrimaryClip(clip)
                    Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
                }
            } catch (_: Throwable) {}
        }
        codeView.setOnLongClickListener {
            // Force focus to ensure clipboard service allows access
            codeView.requestFocus()
            false
        }

        // Start/stop timer
        if (showPreview) {
            if (totpHandler == null) totpHandler = Handler(Looper.getMainLooper())
            val handler = totpHandler!!
            totpRunnable?.let { handler.removeCallbacks(it) }
        cachedTotpSecret = store.getTwoFASecret()
            totpRunnable = object : Runnable {
                override fun run() {
                    val step = 30
                    val nowSec = (System.currentTimeMillis() / 1000L).toInt()
                    val rem = step - (nowSec % step)
                    val pct = ((rem / step.toFloat()) * 100).toInt().coerceIn(0,100)
                    ring.progress = pct
                    if (nowSec != lastTotpRenderedSecond) {
                        lastTotpRenderedSecond = nowSec
                        try {
                            val secret = cachedTotpSecret ?: store.getTwoFASecret()
                            val code = store.getTOTPCodeFromSecret(secret)
                            codeView.text = if (code.isNotBlank()) code else "—"
                        } catch (_: Throwable) { codeView.text = "—" }
                    }
            handler.postDelayed(this, 1000) // 1s tick is sufficient; progress jumps per second
                }
            }
            handler.post(totpRunnable!!)
        } else {
            totpHandler?.let { h -> totpRunnable?.let { h.removeCallbacks(it) } }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        totpHandler?.let { h -> totpRunnable?.let { h.removeCallbacks(it) } }
        totpRunnable = null
        totpHandler = null
    cachedTotpSecret = null
    }
}
