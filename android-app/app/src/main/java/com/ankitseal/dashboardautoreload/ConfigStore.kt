package com.ankitseal.dashboardautoreload

import android.content.Context
import android.util.Log
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Simple JSON-backed config compatible with the Electron app's config.json keys. */
class ConfigStore(private val context: Context) {
    private val TAG = "DAR.ConfigStore"
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
        var tabTimeoutSec: Int = 600,
        var twoFAEnabled: Boolean = false,
        var hasTwoFASecret: Boolean = false
    )

    private fun baseDir(): File {
        val base = File(context.filesDir, "DashboardAutoReload")
        if (!base.exists()) base.mkdirs()
    try { Log.w(TAG, "baseDir=${base.absolutePath} exists=${base.exists()}") } catch (_: Throwable) {}
        return base
    }

    private fun configFile(): File = File(baseDir(), "config.json")
    private fun keyFile(): File = File(baseDir(), "key.bin")

    private fun getOrCreateKey(): SecretKey {
        val f = keyFile()
        if (!f.exists()) {
            val buf = ByteArray(32)
            SecureRandom().nextBytes(buf)
            f.writeBytes(buf)
        }
        val keyBytes = f.readBytes()
        return SecretKeySpec(keyBytes.copyOf(32), "AES")
    }

    private fun encryptJson(obj: JSONObject): JSONObject? {
        return try {
            val key = getOrCreateKey()
            val iv = ByteArray(12)
            SecureRandom().nextBytes(iv)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            val data = cipher.doFinal(obj.toString().toByteArray(Charsets.UTF_8))
            JSONObject().apply {
                put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
                put("tag", Base64.encodeToString(data.takeLast(16).toByteArray(), Base64.NO_WRAP)) // kept for structural parity
                put("data", Base64.encodeToString(data, Base64.NO_WRAP))
            }
        } catch (_: Throwable) { null }
    }

    private fun decryptJson(enc: JSONObject?): JSONObject? {
        if (enc == null) return null
        return try {
            val ivB64 = enc.optString("iv", "")
            val dataB64 = enc.optString("data", "")
            if (ivB64.isBlank() || dataB64.isBlank()) return null
            val key = getOrCreateKey()
            val iv = Base64.decode(ivB64, Base64.NO_WRAP)
            val data = Base64.decode(dataB64, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            val out = cipher.doFinal(data)
            JSONObject(String(out, Charsets.UTF_8))
        } catch (_: Throwable) { null }
    }

    fun load(): Config {
        val f = configFile()
        if (!f.exists()) {
            try { Log.w(TAG, "load: no config file at ${f.absolutePath}") } catch (_: Throwable) {}
            return Config()
        }
        return try {
            val txt = f.readText()
            try { Log.w(TAG, "load: read ${txt.length} bytes from ${f.absolutePath}") } catch (_: Throwable) {}
            val o = JSONObject(txt)
            val cfg = Config()
            cfg.url = o.optString("url", "")
            cfg.session = o.optString("session", "")
            cfg.keepAliveSec = o.optInt("keepAliveSec", 0)
            cfg.reloadAfterSec = o.optInt("reloadAfterSec", 0)
            cfg.waitForCss = if (o.has("waitForCss")) {
                val v = o.optString("waitForCss", "")
                if (v.isBlank()) null else v
            } else null
            // Prefer encrypted user if available
            val userEnc = o.optJSONObject("userEnc")
            val userPlain = o.optJSONObject("user")
            if (userEnc != null) {
                val dec = decryptJson(userEnc)
                if (dec != null) cfg.user = User(dec.optString("email",""), dec.optString("password",""))
                else if (userPlain != null) cfg.user = User(userPlain.optString("email",""), userPlain.optString("password",""))
            } else if (userPlain != null) {
                cfg.user = User(userPlain.optString("email",""), userPlain.optString("password",""))
            }
            val tw = o.optJSONObject("timeWindow")
            if (tw != null) cfg.timeWindow = TimeWindow(
                tw.optBoolean("enabled", false),
                tw.optString("start", "12:00"),
                tw.optString("duration", "1d")
            )
            cfg.autoReloadEnabled = o.optBoolean("autoReloadEnabled", false)
            cfg.navigateBackEnabled = o.optBoolean("navigateBackEnabled", true)
            cfg.tabTimeoutSec = o.optInt("tabTimeoutSec", 600)
            cfg.twoFAEnabled = o.optBoolean("twoFAEnabled", false)
            cfg.hasTwoFASecret = o.has("twoFAEnc")
            try { Log.w(TAG, "load: url='${cfg.url}', keepAlive=${cfg.keepAliveSec}, reloadAfter=${cfg.reloadAfterSec}, autoReload=${cfg.autoReloadEnabled}, tw=${cfg.timeWindow.enabled}:${cfg.timeWindow.start}/${cfg.timeWindow.duration}") } catch (_: Throwable) {}
            cfg
        } catch (_: Throwable) {
            try { Log.w(TAG, "load: failed to parse, returning defaults") } catch (_: Throwable) {}
            Config()
        }
    }

    fun save(cfg: Config) {
        val f = configFile()
        // Start from existing file to preserve encrypted blobs when not touched
        val existing = try { if (configFile().exists()) JSONObject(configFile().readText()) else JSONObject() } catch (_: Throwable) { JSONObject() }
        val o = JSONObject()
        o.put("url", cfg.url)
        o.put("session", cfg.session)
        o.put("keepAliveSec", cfg.keepAliveSec)
        o.put("reloadAfterSec", cfg.reloadAfterSec)
        if (cfg.waitForCss != null) o.put("waitForCss", cfg.waitForCss)
        val hasUser = cfg.user.email.isNotBlank() || cfg.user.password.isNotBlank()
        if (hasUser) {
            encryptJson(JSONObject().apply {
                put("email", cfg.user.email)
                put("password", cfg.user.password)
            })?.let { o.put("userEnc", it) }
        } else if (existing.has("userEnc")) {
            // preserve prior encrypted creds if present and user fields empty
            o.put("userEnc", existing.getJSONObject("userEnc"))
        }
        val tw = JSONObject()
        tw.put("enabled", cfg.timeWindow.enabled)
        tw.put("start", cfg.timeWindow.start)
        tw.put("duration", cfg.timeWindow.duration)
        o.put("timeWindow", tw)
        o.put("autoReloadEnabled", cfg.autoReloadEnabled)
        o.put("navigateBackEnabled", cfg.navigateBackEnabled)
        o.put("tabTimeoutSec", cfg.tabTimeoutSec)
        o.put("twoFAEnabled", cfg.twoFAEnabled)
        // Preserve twoFAEnc unless removed explicitly via removeTwoFASecret()
        if (existing.has("twoFAEnc")) o.put("twoFAEnc", existing.getJSONObject("twoFAEnc"))
        val json = o.toString(2)
        f.writeText(json)
        try {
            val verifyTxt = f.readText()
            val verify = JSONObject(verifyTxt)
            Log.w(TAG, "save: wrote ${json.length} bytes to ${f.absolutePath}; roundTrip.url='${verify.optString("url", "")}'")
        } catch (e: Throwable) {
            try { Log.w(TAG, "save: failed verify read: ${e.message}") } catch (_: Throwable) {}
        }
    }

    fun registerTwoFA(secretRaw: String) {
        val secret = extractBase32Secret(secretRaw)
        if (secret.isBlank()) return
        try { Log.w(TAG, "registerTwoFA: registering secret len=${secret.length}") } catch (_: Throwable) {}
        val existing = try { if (configFile().exists()) JSONObject(configFile().readText()) else JSONObject() } catch (_: Throwable) { JSONObject() }
        encryptJson(JSONObject().apply { put("secret", secret) })?.let { enc ->
            existing.put("twoFAEnc", enc)
            existing.put("twoFAEnabled", true)
            configFile().writeText(existing.toString(2))
            try { Log.w(TAG, "registerTwoFA: saved twoFAEnc; file=${configFile().absolutePath}") } catch (_: Throwable) {}
        }
    }

    fun removeTwoFASecret() {
        val existing = try { if (configFile().exists()) JSONObject(configFile().readText()) else JSONObject() } catch (_: Throwable) { JSONObject() }
        existing.remove("twoFAEnc")
        configFile().writeText(existing.toString(2))
    try { Log.w(TAG, "removeTwoFASecret: removed; file=${configFile().absolutePath}") } catch (_: Throwable) {}
    }

    fun hasTwoFA(): Boolean {
        val existing = try { if (configFile().exists()) JSONObject(configFile().readText()) else JSONObject() } catch (_: Throwable) { JSONObject() }
    val has = existing.has("twoFAEnc")
    try { Log.w(TAG, "hasTwoFA: ${has}") } catch (_: Throwable) {}
    return has
    }

    fun getTOTPCode(): String {
        val existing = try { if (configFile().exists()) JSONObject(configFile().readText()) else JSONObject() } catch (_: Throwable) { JSONObject() }
        val enc = existing.optJSONObject("twoFAEnc") ?: return ""
        val dec = decryptJson(enc) ?: return ""
        val secret = dec.optString("secret", "").trim()
        if (secret.isBlank()) return ""
    val code = generateTOTP(secret)
    try { Log.w(TAG, "getTOTPCode: generated (masked) ****${code.takeLast(2)}") } catch (_: Throwable) {}
    return code
    }

    private fun extractBase32Secret(input: String): String {
        val raw = input.trim()
        return try {
            if (raw.lowercase().startsWith("otpauth://")) {
                val u = android.net.Uri.parse(raw)
                (u.getQueryParameter("secret") ?: "").replace(" ", "").uppercase()
            } else raw.replace(" ", "").uppercase()
        } catch (_: Throwable) { raw.replace(" ", "").uppercase() }
    }

    private fun base32ToBytes(b32: String): ByteArray {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val clean = b32.uppercase().replace("=", "")
        val bits = StringBuilder()
        for (ch in clean) {
            val idx = alphabet.indexOf(ch)
            if (idx >= 0) bits.append(idx.toString(2).padStart(5, '0'))
        }
        val out = ArrayList<Byte>()
        var i = 0
        while (i + 8 <= bits.length) {
            val byteStr = bits.substring(i, i + 8)
            out.add(byteStr.toInt(2).toByte())
            i += 8
        }
        return out.toByteArray()
    }

    private fun hmacSha1(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA1")
        val sk = SecretKeySpec(key, "HmacSHA1")
        mac.init(sk)
        return mac.doFinal(data)
    }

    private fun generateTOTP(secretB32: String, timeStep: Int = 30, digits: Int = 6): String {
        val key = base32ToBytes(secretB32)
        if (key.isEmpty()) return ""
        val counter = (System.currentTimeMillis() / 1000L / timeStep)
        val buf = ByteArray(8)
        // big-endian
        val high = (counter ushr 32).toInt()
        val low = counter.toInt()
        buf[0] = (high ushr 24).toByte(); buf[1] = (high ushr 16).toByte(); buf[2] = (high ushr 8).toByte(); buf[3] = high.toByte()
        buf[4] = (low ushr 24).toByte(); buf[5] = (low ushr 16).toByte(); buf[6] = (low ushr 8).toByte(); buf[7] = low.toByte()
        val h = hmacSha1(key, buf)
        val offset = (h[h.size - 1].toInt() and 0x0f)
        val codeInt = ((h[offset].toInt() and 0x7f) shl 24) or ((h[offset + 1].toInt() and 0xff) shl 16) or ((h[offset + 2].toInt() and 0xff) shl 8) or (h[offset + 3].toInt() and 0xff)
        val mod = Math.floorMod(codeInt, Math.pow(10.0, digits.toDouble()).toInt())
        return mod.toString().padStart(digits, '0')
    }
}
