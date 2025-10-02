package com.ankitseal.dashboardautoreload

import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity

class SettingsActivity : AppCompatActivity() {
    private lateinit var store: ConfigStore

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
        findViewById<CheckBox>(R.id.cb_auto).isChecked = cfg.autoReloadEnabled
        findViewById<EditText>(R.id.et_twstart).setText(cfg.timeWindow.start)
        findViewById<EditText>(R.id.et_twdur).setText(cfg.timeWindow.duration)
        findViewById<CheckBox>(R.id.cb_twenabled).isChecked = cfg.timeWindow.enabled
        findViewById<CheckBox>(R.id.cb_navback).isChecked = cfg.navigateBackEnabled
        findViewById<EditText>(R.id.et_tabto).setText(cfg.tabTimeoutSec.toString())

        findViewById<Button>(R.id.btn_save).setOnClickListener {
            val newCfg = ConfigStore.Config(
                url = findViewById<EditText>(R.id.et_url).text.toString(),
                session = findViewById<EditText>(R.id.et_session).text.toString(),
                keepAliveSec = findViewById<EditText>(R.id.et_keepalive).text.toString().toIntOrNull() ?: 0,
                reloadAfterSec = findViewById<EditText>(R.id.et_reload).text.toString().toIntOrNull() ?: 0,
                waitForCss = findViewById<EditText>(R.id.et_waitcss).text.toString().ifBlank { null },
                user = ConfigStore.User(
                    email = findViewById<EditText>(R.id.et_email).text.toString(),
                    password = findViewById<EditText>(R.id.et_password).text.toString()
                ),
                timeWindow = ConfigStore.TimeWindow(
                    enabled = findViewById<CheckBox>(R.id.cb_twenabled).isChecked,
                    start = findViewById<EditText>(R.id.et_twstart).text.toString().ifBlank { "12:00" },
                    duration = findViewById<EditText>(R.id.et_twdur).text.toString().ifBlank { "1d" }
                ),
                autoReloadEnabled = findViewById<CheckBox>(R.id.cb_auto).isChecked,
                navigateBackEnabled = findViewById<CheckBox>(R.id.cb_navback).isChecked,
                tabTimeoutSec = findViewById<EditText>(R.id.et_tabto).text.toString().toIntOrNull() ?: 0
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
            store.save(newCfg)
            finish()
        }
    }
}
