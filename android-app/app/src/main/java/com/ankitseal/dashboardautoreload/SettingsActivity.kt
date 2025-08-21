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

class SettingsActivity : AppCompatActivity() {
    private lateinit var store: ConfigStore
    private val TAG = "DAR.Settings"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        store = ConfigStore(this)
        val cfg = store.load()

        findViewById<EditText>(R.id.et_url).setText(cfg.url)
        findViewById<EditText>(R.id.et_session).setText(cfg.session)
        findViewById<EditText>(R.id.et_email).setText(cfg.user.email)
        findViewById<EditText>(R.id.et_password).setText(cfg.user.password)
        findViewById<EditText>(R.id.et_keepalive).setText(cfg.keepAliveSec.toString())
        findViewById<EditText>(R.id.et_reload).setText(cfg.reloadAfterSec.toString())
        findViewById<EditText>(R.id.et_waitcss).setText(cfg.waitForCss ?: "")
    findViewById<MaterialSwitch>(R.id.cb_auto).isChecked = cfg.autoReloadEnabled
    findViewById<EditText>(R.id.et_twstart).setText(cfg.timeWindow.start)
    findViewById<EditText>(R.id.et_twdur).setText(cfg.timeWindow.duration)
    findViewById<MaterialSwitch>(R.id.cb_twenabled).isChecked = cfg.timeWindow.enabled
    findViewById<MaterialSwitch>(R.id.cb_navback).isChecked = cfg.navigateBackEnabled
    findViewById<EditText>(R.id.et_tabto).setText(cfg.tabTimeoutSec.toString())
    findViewById<MaterialSwitch>(R.id.cb_twofa).isChecked = cfg.twoFAEnabled
    // Keep secret input enabled initially; we'll hide when registered
    findViewById<EditText>(R.id.et_twofa).isEnabled = true
    syncTwoFASection()

        findViewById<Button>(R.id.btn_save).setOnClickListener {
            val urlStrRaw = findViewById<EditText>(R.id.et_url).text.toString()
            val urlStr = urlStrRaw.trim()
            val sessionRaw = findViewById<EditText>(R.id.et_session).text.toString()
            val session = sessionRaw.trim()
            try { Log.w(TAG, "save:url: lenRaw=${urlStrRaw.length} lenTrim=${urlStr.length} head='${urlStr.take(80)}'") } catch (_: Throwable) {}
            val newCfg = ConfigStore.Config(
                url = urlStr,
                session = session,
                keepAliveSec = findViewById<EditText>(R.id.et_keepalive).text.toString().toIntOrNull() ?: 0,
                reloadAfterSec = findViewById<EditText>(R.id.et_reload).text.toString().toIntOrNull() ?: 0,
                waitForCss = findViewById<EditText>(R.id.et_waitcss).text.toString().ifBlank { null },
                user = ConfigStore.User(
                    email = findViewById<EditText>(R.id.et_email).text.toString(),
                    password = findViewById<EditText>(R.id.et_password).text.toString()
                ),
                timeWindow = ConfigStore.TimeWindow(
                    enabled = findViewById<MaterialSwitch>(R.id.cb_twenabled).isChecked,
                    start = findViewById<EditText>(R.id.et_twstart).text.toString().ifBlank { "12:00" },
                    duration = findViewById<EditText>(R.id.et_twdur).text.toString().ifBlank { "1d" }
                ),
                autoReloadEnabled = findViewById<MaterialSwitch>(R.id.cb_auto).isChecked,
                navigateBackEnabled = findViewById<MaterialSwitch>(R.id.cb_navback).isChecked,
        tabTimeoutSec = findViewById<EditText>(R.id.et_tabto).text.toString().toIntOrNull() ?: 0,
        twoFAEnabled = findViewById<MaterialSwitch>(R.id.cb_twofa).isChecked,
        hasTwoFASecret = store.hasTwoFA()
            )
            // Validation: when rolling enabled and auto enabled, reload must be < duration
            if (newCfg.timeWindow.enabled && newCfg.autoReloadEnabled) {
                val durSec = when (newCfg.timeWindow.duration) {
                    "1h"->3600;"2h"->7200;"6h"->21600;"12h"->43200;"1d"->86400;"2d"->172800;"5d"->432000;"7d"->604800
                    else -> newCfg.timeWindow.duration.filter { it.isDigit() }.toIntOrNull()?.times(3600) ?: 86400
                }
                if (newCfg.reloadAfterSec >= durSec) {
                    newCfg.reloadAfterSec = (durSec - 1).coerceAtLeast(1)
                }
            }
            // Link navBack to tabTimeout
            if (newCfg.navigateBackEnabled && newCfg.tabTimeoutSec <= 0) {
                newCfg.tabTimeoutSec = 250
            } else if (newCfg.tabTimeoutSec <= 0) {
                newCfg.navigateBackEnabled = false
            }
            try {
                Log.w(TAG, "save: url='${newCfg.url}', keepAlive=${newCfg.keepAliveSec}, reloadAfter=${newCfg.reloadAfterSec}, autoReload=${newCfg.autoReloadEnabled}, tw=${newCfg.timeWindow.enabled}:${newCfg.timeWindow.start}/${newCfg.timeWindow.duration}, navBack=${newCfg.navigateBackEnabled}, tabTimeout=${newCfg.tabTimeoutSec}, twoFAEnabled=${newCfg.twoFAEnabled}")
            } catch (_: Throwable) {}
            store.save(newCfg)
            finish()
        }

        findViewById<MaterialSwitch>(R.id.cb_twofa).setOnCheckedChangeListener { _, isChecked ->
            val cfgNow = store.load()
            cfgNow.twoFAEnabled = isChecked
            try { Log.w(TAG, "twoFA.toggle: enabled=$isChecked") } catch (_: Throwable) {}
            store.save(cfgNow)
            syncTwoFASection()
        }
        findViewById<Button>(R.id.btn_twofa_register).setOnClickListener {
            val secret = findViewById<EditText>(R.id.et_twofa).text.toString()
            if (secret.isNotBlank()) {
                try { Log.w(TAG, "twoFA.register: inputLen=${secret.length}") } catch (_: Throwable) {}
                store.registerTwoFA(secret)
                findViewById<EditText>(R.id.et_twofa).setText("")
                // Ensure toggle is enabled after registering
                findViewById<MaterialSwitch>(R.id.cb_twofa).isChecked = true
                Toast.makeText(this, "2FA key registered", Toast.LENGTH_SHORT).show()
            }
            syncTwoFASection()
        }
        findViewById<Button>(R.id.btn_twofa_remove).setOnClickListener {
            try { Log.w(TAG, "twoFA.remove: clicked") } catch (_: Throwable) {}
            store.removeTwoFASecret()
            syncTwoFASection()
        }
    }

    private var totpHandler: Handler? = null
    private var totpRunnable: Runnable? = null

    private fun syncTwoFASection() {
        val hasSecret = store.hasTwoFA()
        val enabled = store.load().twoFAEnabled
        try { Log.w(TAG, "twoFA.sync: has=$hasSecret enabled=$enabled") } catch (_: Throwable) {}
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

        // Tap-to-copy
        codeView.setOnClickListener {
            try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("TOTP", codeView.text.toString().replace(" ", ""))
                cm.setPrimaryClip(clip)
                Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
            } catch (_: Throwable) {}
        }

        // Start/stop timer
        if (showPreview) {
            if (totpHandler == null) totpHandler = Handler(Looper.getMainLooper())
            val handler = totpHandler!!
            totpRunnable?.let { handler.removeCallbacks(it) }
            totpRunnable = object : Runnable {
                override fun run() {
                    try {
                        val code = store.getTOTPCode()
                        codeView.text = if (code.isNotBlank()) code else "—"
                        // ring progress - 0..100 based on remaining time
                        val step = 30
                        val now = (System.currentTimeMillis() / 1000L).toInt()
                        val rem = step - (now % step)
                        val pct = ((rem / step.toFloat()) * 100).toInt().coerceIn(0, 100)
                        ring.progress = pct
                    } catch (_: Throwable) {
                        codeView.text = "—"
                    }
                    handler.postDelayed(this, 1000)
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
    }
}
