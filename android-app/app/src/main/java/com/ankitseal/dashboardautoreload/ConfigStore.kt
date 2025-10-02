package com.ankitseal.dashboardautoreload

import android.content.Context
import org.json.JSONObject
import java.io.File

/** Simple JSON-backed config compatible with the Electron app's config.json keys. */
class ConfigStore(private val context: Context) {
    data class TimeWindow(
        var enabled: Boolean = false,
        var start: String = "12:00",
        var duration: String = "1d"
    )
    data class User(var email: String = "", var password: String = "")
    data class Config(
        var url: String = "",
        var session: String = "",
        var keepAliveSec: Int = 0,
        var reloadAfterSec: Int = 0,
        var waitForCss: String? = null,
        var user: User = User(),
        var timeWindow: TimeWindow = TimeWindow(),
        var autoReloadEnabled: Boolean = false,
        var navigateBackEnabled: Boolean = true,
        var tabTimeoutSec: Int = 600
    )

    private fun configFile(): File {
        val base = File(context.filesDir, "DashboardAutoReload")
        if (!base.exists()) base.mkdirs()
        return File(base, "config.json")
    }

    fun load(): Config {
        val f = configFile()
        if (!f.exists()) return Config()
        return try {
            val txt = f.readText()
            val o = JSONObject(txt)
            val cfg = Config()
            cfg.url = o.optString("url", "")
            cfg.session = o.optString("session", "")
            cfg.keepAliveSec = o.optInt("keepAliveSec", 0)
            cfg.reloadAfterSec = o.optInt("reloadAfterSec", 0)
            cfg.waitForCss = if (o.has("waitForCss")) o.optString("waitForCss", null) else null
            val user = o.optJSONObject("user")
            if (user != null) cfg.user = User(user.optString("email",""), user.optString("password",""))
            val tw = o.optJSONObject("timeWindow")
            if (tw != null) cfg.timeWindow = TimeWindow(
                tw.optBoolean("enabled", false),
                tw.optString("start", "12:00"),
                tw.optString("duration", "1d")
            )
            cfg.autoReloadEnabled = o.optBoolean("autoReloadEnabled", false)
            cfg.navigateBackEnabled = o.optBoolean("navigateBackEnabled", true)
            cfg.tabTimeoutSec = o.optInt("tabTimeoutSec", 600)
            cfg
        } catch (_: Throwable) {
            Config()
        }
    }

    fun save(cfg: Config) {
        val o = JSONObject()
        o.put("url", cfg.url)
        o.put("session", cfg.session)
        o.put("keepAliveSec", cfg.keepAliveSec)
        o.put("reloadAfterSec", cfg.reloadAfterSec)
        if (cfg.waitForCss != null) o.put("waitForCss", cfg.waitForCss)
        val u = JSONObject()
        u.put("email", cfg.user.email)
        u.put("password", cfg.user.password)
        o.put("user", u)
        val tw = JSONObject()
        tw.put("enabled", cfg.timeWindow.enabled)
        tw.put("start", cfg.timeWindow.start)
        tw.put("duration", cfg.timeWindow.duration)
        o.put("timeWindow", tw)
        o.put("autoReloadEnabled", cfg.autoReloadEnabled)
        o.put("navigateBackEnabled", cfg.navigateBackEnabled)
        o.put("tabTimeoutSec", cfg.tabTimeoutSec)
        configFile().writeText(o.toString(2))
    }
}
