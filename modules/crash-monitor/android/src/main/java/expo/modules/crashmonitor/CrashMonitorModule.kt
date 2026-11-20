package expo.modules.crashmonitor

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CrashMonitorModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is not available")

  override fun definition() = ModuleDefinition {
    Name("CrashMonitor")

    /** Starts (or reconfigures) background monitoring for the signed-in account. */
    Function("start") { baseUrl: String, token: String, mode: String, path: String, intervalMs: Double ->
      val prefs = CrashMonitorPrefs(context)
      if (prefs.token != token || prefs.path != path || prefs.baseUrl != baseUrl) {
        prefs.seen = emptySet()
        prefs.primed = false
      }
      prefs.baseUrl = baseUrl
      prefs.token = token
      prefs.mode = mode
      prefs.path = path
      prefs.intervalMs = intervalMs.toLong()
      prefs.enabled = true
      CrashMonitorService.createChannels(context)
      CrashMonitorService.start(context)
      true
    }

    /** Stops monitoring and forgets the session (sign-out). */
    Function("stop") {
      CrashMonitorPrefs(context).clearSession()
      context.stopService(Intent(context, CrashMonitorService::class.java))
      notifications().cancel(CrashMonitorService.ALARM_ID)
      notifications().cancel(CrashMonitorService.STATUS_ID)
    }

    /** Silences the background alarm once the person has seen the in-app alarm. */
    Function("cancelAlarm") {
      notifications().cancel(CrashMonitorService.ALARM_ID)
    }

    Function("status") {
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      mapOf(
        "enabled" to CrashMonitorPrefs(context).enabled,
        "running" to CrashMonitorService.running,
        "notificationsAllowed" to notifications().areNotificationsEnabled(),
        "fullScreenAllowed" to (Build.VERSION.SDK_INT < 34 || notifications().canUseFullScreenIntent()),
        "batteryUnrestricted" to (Build.VERSION.SDK_INT < 23 || power.isIgnoringBatteryOptimizations(context.packageName)),
      )
    }

    /** Android 14+: full-screen alarms need the user's permission for apps that are not clocks. */
    Function("openFullScreenSettings") {
      val intent = if (Build.VERSION.SDK_INT >= 34) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Asks Android not to pause the monitor to save battery. */
    Function("requestBatteryExemption") {
      if (Build.VERSION.SDK_INT >= 23) {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    /** Lets the in-app alarm show over the lock screen and turn the screen on while it is active. */
    Function("setShowOverLockScreen") { show: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      if (Build.VERSION.SDK_INT >= 27) {
        activity.runOnUiThread {
          activity.setShowWhenLocked(show)
          activity.setTurnScreenOn(show)
        }
      }
    }
  }

  private fun notifications() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
}
