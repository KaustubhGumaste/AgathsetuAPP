package expo.modules.crashmonitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Turns the crash monitor back on after a reboot or app update, if the user had it on. */
class CrashMonitorBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val prefs = CrashMonitorPrefs(context)
    if (prefs.enabled && prefs.token.isNotBlank() && prefs.baseUrl.isNotBlank()) {
      runCatching { CrashMonitorService.start(context) }
    }
  }
}
