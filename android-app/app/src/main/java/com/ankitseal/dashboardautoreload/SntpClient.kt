package com.ankitseal.dashboardautoreload

import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Lightweight SNTP client to get accurate network time without relying on system clock.
 * - Caches offset for a short TTL to avoid frequent network calls.
 * - Uses UDP/123 to query well-known NTP servers.
 * - Safe to call from any thread; network fetch runs in a background thread via ensureSyncAsync().
 */
object SntpClient {
    private const val TAG = "DAR.Sntp"
    private val servers = arrayOf(
        "time.google.com",
        "time.cloudflare.com",
        "time.windows.com",
        "pool.ntp.org"
    )

    @Volatile private var offsetMs: Long? = null
    @Volatile private var lastSyncAtMs: Long = 0L
    private val syncing = AtomicBoolean(false)
    private const val TTL_MS: Long = 10 * 60 * 1000 // 10 minutes
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun isFresh(): Boolean {
        val last = lastSyncAtMs
        return last > 0 && (System.currentTimeMillis() - last) < TTL_MS
    }

    fun currentTimeMillis(): Long {
        val off = offsetMs
        val now = System.currentTimeMillis()
        return if (off != null) now + off else now
    }

    fun ensureSyncAsync() {
        if (isFresh()) return
        if (!syncing.compareAndSet(false, true)) return
        scope.launch {
            try { syncNowInternal() } finally { syncing.set(false) }
        }
    }

    private fun syncNowInternal(timeoutMs: Int = 800) {
        for (host in servers) {
            try {
                val off = queryOffset(host, timeoutMs)
                if (off != null) {
                    offsetMs = off
                    lastSyncAtMs = System.currentTimeMillis()
                    try { Log.w(TAG, "synced host=$host offsetMs=$off") } catch (_: Throwable) {}
                    return
                }
            } catch (e: Throwable) {
                // try next host
            }
        }
        try { Log.w(TAG, "sync failed: all hosts timed out") } catch (_: Throwable) {}
    }

    private fun queryOffset(host: String, timeoutMs: Int): Long? {
        val addr = InetAddress.getByName(host)
        val buf = ByteArray(48)
        buf[0] = 0x1B.toByte() // LI=0, VN=3, Mode=3 (client)

        val socket = DatagramSocket()
        socket.soTimeout = timeoutMs
        return try {
            val request = DatagramPacket(buf, buf.size, addr, 123)
            // t1: client transmit time (ms since Unix epoch)
            val t1 = System.currentTimeMillis()
            writeTimestamp(buf, 40, t1)
            socket.send(request)

            val response = DatagramPacket(ByteArray(48), 48)
            socket.receive(response)
            val t4 = System.currentTimeMillis()
            val resp = response.data

            // Extract server times (NTP epoch -> Unix epoch conversions handled in readTimestamp)
            val t2 = readTimestamp(resp, 32) // server receive time
            val t3 = readTimestamp(resp, 40) // server transmit time
            if (t2 == 0L || t3 == 0L) return null

            // Standard NTP offset calculation (in ms): theta = ((t2 - t1) + (t3 - t4)) / 2
            val offset = ((t2 - t1) + (t3 - t4)) / 2
            offset
        } catch (e: SocketTimeoutException) {
            null
        } catch (e: Throwable) {
            null
        } finally {
            try { socket.close() } catch (_: Throwable) {}
        }
    }

    private fun readTimestamp(buf: ByteArray, offset: Int): Long {
        // NTP timestamp is 64 bits: seconds since 1900-01-01 and fractional seconds
        val seconds = readUnsignedInt(buf, offset)
        val fraction = readUnsignedInt(buf, offset + 4)
        if (seconds == 0L && fraction == 0L) return 0L
        val unixSeconds = seconds - 2208988800L // convert NTP epoch -> Unix epoch
        val ms = (unixSeconds * 1000L) + ((fraction * 1000L) ushr 32)
        return ms
    }

    private fun writeTimestamp(buf: ByteArray, offset: Int, timeMs: Long) {
        // Convert Unix epoch ms -> NTP seconds + fraction
        val seconds = (timeMs / 1000L) + 2208988800L
        val fraction = ((timeMs % 1000L) * 0x100000000L) / 1000L
        writeUnsignedInt(buf, offset, seconds)
        writeUnsignedInt(buf, offset + 4, fraction)
    }

    private fun readUnsignedInt(buf: ByteArray, offset: Int): Long {
        var value = 0L
        for (i in 0 until 4) {
            value = (value shl 8) or (buf[offset + i].toInt() and 0xff).toLong()
        }
        return value
    }

    private fun writeUnsignedInt(buf: ByteArray, offset: Int, value: Long) {
        var v = value
        for (i in 3 downTo 0) {
            buf[offset + i] = (v and 0xff).toByte()
            v = v ushr 8
        }
    }
}
