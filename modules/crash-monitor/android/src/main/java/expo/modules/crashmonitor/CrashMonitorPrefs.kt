package expo.modules.crashmonitor

import android.content.Context
import android.content.SharedPreferences

/**
 * What the background service needs between app launches and reboots. Stored in the app's private
 * preferences, which other apps cannot read.
 */
internal class CrashMonitorPrefs(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences("aghatsethu.crash_monitor", Context.MODE_PRIVATE)

  var enabled: Boolean
    get() = prefs.getBoolean("enabled", false)
    set(value) = prefs.edit().putBoolean("enabled", value).apply()

  var baseUrl: String
    get() = prefs.getString("base_url", "") ?: ""
    set(value) = prefs.edit().putString("base_url", value).apply()

  var token: String
    get() = prefs.getString("token", "") ?: ""
    set(value) = prefs.edit().putString("token", value).apply()

  /** "citizen" watches the user's notifications; "authority" watches the incident board. */
  var mode: String
    get() = prefs.getString("mode", "citizen") ?: "citizen"
    set(value) = prefs.edit().putString("mode", value).apply()

  /** API path polled for the current mode (the app passes the right one for the connected server). */
  var path: String
    get() = prefs.getString("path", "") ?: ""
    set(value) = prefs.edit().putString("path", value).apply()

  var intervalMs: Long
    get() = prefs.getLong("interval_ms", 5000L)
    set(value) = prefs.edit().putLong("interval_ms", value).apply()

  /** Record ids (notifications or incidents) already seen, so each crash alarms once. */
  var seen: Set<String>
    get() = prefs.getStringSet("seen", emptySet()) ?: emptySet()
    set(value) = prefs.edit().putStringSet("seen", value.toList().takeLast(500).toSet()).apply()

  var primed: Boolean
    get() = prefs.getBoolean("primed", false)
    set(value) = prefs.edit().putBoolean("primed", value).apply()

  fun clearSession() {
    prefs.edit()
      .putBoolean("enabled", false)
      .remove("token")
      .remove("seen")
      .putBoolean("primed", false)
      .apply()
  }
}
