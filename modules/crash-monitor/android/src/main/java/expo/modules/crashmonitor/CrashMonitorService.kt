package expo.modules.crashmonitor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

/**
 * Foreground service that keeps watching the AGHAT SETHU server while the app is closed.
 *
 * Citizen mode polls the user's notifications: the server has already matched the crashed vehicle's
 * plate to its registered owner, so a new unread crash notification means "your vehicle crashed".
 * Authority mode polls the incident board and alarms for every new unresolved crash.
 * A new crash raises a full-screen, insistent alarm notification that opens the app, where the
 * in-app alarm takes over until the person answers.
 */
class CrashMonitorService : Service() {
  @Volatile private var worker: Thread? = null
  @Volatile private var stopping = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val prefs = CrashMonitorPrefs(this)
    createChannels(this)
    goForeground(statusNotification("Watching for crashes involving your vehicles."))
    if (!prefs.enabled || prefs.token.isBlank() || prefs.baseUrl.isBlank()) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (worker?.isAlive != true) {
      stopping = false
      worker = Thread({ loop() }, "aghatsethu-crash-monitor").also { it.start() }
    }
    running = true
    return START_STICKY
  }

  override fun onDestroy() {
    stopping = true
    worker?.interrupt()
    running = false
    super.onDestroy()
  }

  private fun goForeground(notification: Notification) {
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(STATUS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(STATUS_ID, notification)
    }
  }

  private fun loop() {
    var offline = false
    while (!stopping) {
      val prefs = CrashMonitorPrefs(this)
      if (!prefs.enabled) break
      try {
        poll(prefs)
        if (offline) {
          offline = false
          notify(STATUS_ID, statusNotification("Watching for crashes involving your vehicles."))
        }
      } catch (expired: SessionExpired) {
        prefs.clearSession()
        notify(SESSION_ID, simpleNotification(
          "Crash alarm is off",
          "Your AGHAT SETHU session ended. Open the app and sign in again to turn the crash alarm back on.",
        ))
        break
      } catch (error: Exception) {
        if (!offline) {
          offline = true
          notify(STATUS_ID, statusNotification("Waiting for a connection to the AGHAT SETHU server…"))
        }
      }
      try {
        Thread.sleep(prefs.intervalMs.coerceIn(3000L, 60000L))
      } catch (_: InterruptedException) {
        break
      }
    }
    running = false
    stopForegroundCompat()
    stopSelf()
  }

  @Suppress("DEPRECATION")
  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
  }

  private class SessionExpired : Exception()

  private fun poll(prefs: CrashMonitorPrefs) {
    val body = get(prefs.baseUrl.trimEnd('/') + prefs.path, prefs.token)
    val records = if (prefs.mode == "authority") boardIncidents(body) else crashNotifications(body)
    val seen = prefs.seen.toMutableSet()
    val firstPoll = !prefs.primed
    var alarm: Record? = null
    for (record in records) {
      if (record.id in seen) continue
      seen.add(record.id)
      // The first poll after sign-in only learns what already exists, except a crash from the
      // last few minutes that has not been answered yet.
      val fresh = !firstPoll || (record.createdAt != null && record.createdAt > System.currentTimeMillis() - 600_000L)
      if (record.alarm && fresh && alarm == null) alarm = record
    }
    prefs.seen = seen
    prefs.primed = true
    alarm?.let { raiseAlarm(prefs.mode, it) }
  }

  /** createdAt: epoch milliseconds, or null when the server gave no parseable time. */
  private data class Record(val id: String, val alarm: Boolean, val junction: String, val createdAt: Long?)

  private fun crashNotifications(body: String): List<Record> {
    return list(body, "notifications").mapNotNull { item ->
      val id = item.optString("id").ifBlank { return@mapNotNull null }
      val kind = item.optString("kind").ifBlank { item.optString("type") }.lowercase()
      val incident = item.optString("incident_id")
      val read = item.optBoolean("read", false) || (item.has("read_at") && !item.isNull("read_at"))
      Record(id, kind.contains("crash") && incident.isNotBlank() && incident != "null" && !read, "", time(item.optString("created_at")))
    }
  }

  private fun boardIncidents(body: String): List<Record> {
    val root = runCatching { JSONObject(body) }.getOrNull()
    val items = when {
      root?.optJSONArray("unresolved") != null -> array(root.getJSONArray("unresolved"))
      root?.optJSONArray("active") != null -> array(root.getJSONArray("active")).filter { !it.optBoolean("resolved", false) }
      else -> list(body, "incidents")
    }
    return items.mapNotNull { item ->
      val id = item.optString("id").ifBlank { return@mapNotNull null }
      val junction = item.optString("junction_id").ifBlank { item.optString("crash_junction") }
      Record(id, true, junction, time(item.optString("created_at").ifBlank { item.optString("occurred_at") }))
    }
  }

  private fun list(body: String, key: String): List<JSONObject> {
    val trimmed = body.trim()
    if (trimmed.startsWith("[")) return array(JSONArray(trimmed))
    val root = JSONObject(trimmed)
    for (name in listOf(key, "items", "results", "data")) {
      root.optJSONArray(name)?.let { return array(it) }
    }
    return emptyList()
  }

  private fun array(values: JSONArray): List<JSONObject> =
    (0 until values.length()).mapNotNull { values.optJSONObject(it) }

  private fun time(value: String): Long? {
    if (value.isBlank() || value == "null" || Build.VERSION.SDK_INT < 26) return null
    return try {
      OffsetDateTime.parse(value).toInstant().toEpochMilli()
    } catch (_: DateTimeParseException) {
      // Server timestamps without an offset are UTC.
      try { Instant.parse(value + "Z").toEpochMilli() } catch (_: DateTimeParseException) { null }
    }
  }

  private fun get(url: String, token: String): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 10000
      connection.readTimeout = 15000
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("Accept", "application/json")
      val code = connection.responseCode
      if (code == 401 || code == 403) throw SessionExpired()
      if (code !in 200..299) throw IllegalStateException("HTTP $code")
      return connection.inputStream.bufferedReader().use { it.readText() }
    } finally {
      connection.disconnect()
    }
  }

  private fun raiseAlarm(mode: String, record: Record) {
    val citizen = mode != "authority"
    val title = if (citizen) "Possible crash involving your vehicle" else
      "Crash detected" + (if (record.junction.isNotBlank()) " at ${record.junction}" else "")
    val text = if (citizen) "Open AGHAT SETHU now and tell us whether you are safe." else
      "Open AGHAT SETHU to acknowledge and review the incident."
    // Wake the screen so the full-screen alarm is seen even if the phone is asleep.
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    @Suppress("DEPRECATION")
    power.newWakeLock(
      PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
      "aghatsethu:crash-alarm",
    ).acquire(10_000L)
    notify(ALARM_ID, alarmNotification(this, title, text, record.id))
  }

  private fun notify(id: Int, notification: Notification) {
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(id, notification)
  }

  private fun statusNotification(text: String): Notification =
    builder(this, STATUS_CHANNEL)
      .setContentTitle("AGHAT SETHU crash alarm is on")
      .setContentText(text)
      .setSmallIcon(smallIcon(this))
      .setOngoing(true)
      .setContentIntent(openApp(this, null))
      .build()

  private fun simpleNotification(title: String, text: String): Notification =
    builder(this, STATUS_CHANNEL)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setSmallIcon(smallIcon(this))
      .setAutoCancel(true)
      .setContentIntent(openApp(this, null))
      .build()

  companion object {
    const val STATUS_CHANNEL = "crash-monitor-status"
    const val ALARM_CHANNEL = "crash-alarm-fullscreen-v1"
    const val STATUS_ID = 9000
    const val ALARM_ID = 9001
    const val SESSION_ID = 9002
    const val EXTRA_CRASH = "aghatsethu_crash"

    @Volatile var running = false

    fun createChannels(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.createNotificationChannel(
        NotificationChannel(STATUS_CHANNEL, "Crash alarm status", NotificationManager.IMPORTANCE_MIN).apply {
          description = "Shows that AGHAT SETHU is watching for crashes in the background."
          setShowBadge(false)
        },
      )
      manager.createNotificationChannel(
        NotificationChannel(ALARM_CHANNEL, "Crash alarm (full screen)", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Loud full-screen alarm when a crash involving your vehicle is reported."
          setSound(alarmSound(context), AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build())
          enableVibration(true)
          vibrationPattern = longArrayOf(0, 1000, 500, 1000, 500, 1000)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          setBypassDnd(true)
        },
      )
    }

    /** The app's siren (res/raw/crash_alarm.wav) if bundled, otherwise the phone's alarm tone. */
    fun alarmSound(context: Context): Uri {
      val raw = context.resources.getIdentifier("crash_alarm", "raw", context.packageName)
      return if (raw != 0) Uri.parse("android.resource://${context.packageName}/$raw")
      else RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
    }

    @Suppress("DEPRECATION")
    fun builder(context: Context, channel: String): Notification.Builder =
      if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, channel) else Notification.Builder(context)

    fun smallIcon(context: Context): Int {
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      return if (icon != 0) icon else context.applicationInfo.icon
    }

    fun openApp(context: Context, crashId: String?): PendingIntent {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)!!.apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        if (crashId != null) putExtra(EXTRA_CRASH, crashId)
      }
      return PendingIntent.getActivity(
        context, if (crashId != null) 1 else 0, launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    @Suppress("DEPRECATION")
    fun alarmNotification(context: Context, title: String, text: String, crashId: String): Notification {
      val open = openApp(context, crashId)
      val builder = builder(context, ALARM_CHANNEL)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(Notification.BigTextStyle().bigText(text))
        .setSmallIcon(smallIcon(context))
        .setCategory(Notification.CATEGORY_ALARM)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(false)
        .setColor(0xFFD92D20.toInt())
        .setContentIntent(open)
        .setFullScreenIntent(open, true)
      if (Build.VERSION.SDK_INT < 26) {
        builder.setPriority(Notification.PRIORITY_MAX)
          .setSound(alarmSound(context), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
          .setVibrate(longArrayOf(0, 1000, 500, 1000))
      }
      // Insistent: the siren repeats until the person opens the app or the alarm is cancelled.
      return builder.build().apply { flags = flags or Notification.FLAG_INSISTENT }
    }

    fun start(context: Context) {
      val intent = Intent(context, CrashMonitorService::class.java)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    }
  }
}
