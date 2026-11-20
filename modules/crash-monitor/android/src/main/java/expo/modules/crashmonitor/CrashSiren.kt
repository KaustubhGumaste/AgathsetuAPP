package expo.modules.crashmonitor

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * The crash siren: a looping alarm on the phone's ALARM stream at full volume, plus alarm vibration.
 *
 * The alarm stream still plays when the phone is on silent or vibrate. While the siren runs, a
 * watchdog puts the alarm volume back to maximum if the volume buttons turn it down, and restarts
 * playback if something stops it. If the person allowed Do Not Disturb access, DND is switched off
 * for the duration of the alarm. The phone's previous volume and DND state are restored afterwards.
 *
 * One siren for the whole app: the background service and the in-app alarm both drive this object.
 */
object CrashSiren {
  private val main = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null
  private var focus: AudioFocusRequest? = null
  private var savedVolume = -1
  private var savedFilter = -1
  private var muted = false
  @Volatile var playing = false
    private set

  private val alarmAttributes: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()

  private val watchdog = object : Runnable {
    override fun run() {
      if (!playing) return
      val context = appContext ?: return
      if (!muted) {
        forceVolume(context)
        val current = player
        if (current == null || !runCatching { current.isPlaying }.getOrDefault(false)) startPlayer(context)
      }
      main.postDelayed(this, 500)
    }
  }

  private var appContext: Context? = null

  /** Starts the siren (no-op when already sounding). Safe to call from any thread. */
  fun start(context: Context) {
    main.post {
      appContext = context.applicationContext
      if (playing) {
        if (muted) setMuted(false)
        return@post
      }
      playing = true
      muted = false
      val ctx = context.applicationContext
      overrideDnd(ctx)
      forceVolume(ctx)
      requestFocus(ctx)
      startPlayer(ctx)
      vibrate(ctx)
      main.removeCallbacks(watchdog)
      main.postDelayed(watchdog, 500)
    }
  }

  /** Stops the siren and gives the phone back its own volume and Do Not Disturb settings. */
  fun stop() {
    main.post {
      if (!playing) return@post
      playing = false
      muted = false
      main.removeCallbacks(watchdog)
      releasePlayer()
      val ctx = appContext ?: return@post
      vibrator(ctx)?.cancel()
      abandonFocus(ctx)
      restoreVolume(ctx)
      restoreDnd(ctx)
    }
  }

  /** Pauses only the sound (e.g. during an emergency call); vibration and the alarm itself continue. */
  fun setMuted(value: Boolean) {
    main.post {
      if (!playing || muted == value) return@post
      muted = value
      val ctx = appContext ?: return@post
      if (value) releasePlayer() else {
        forceVolume(ctx)
        startPlayer(ctx)
      }
    }
  }

  fun dndAccessGranted(context: Context): Boolean =
    Build.VERSION.SDK_INT < 23 || notifications(context).isNotificationPolicyAccessGranted

  private fun startPlayer(context: Context) {
    releasePlayer()
    player = runCatching {
      MediaPlayer().apply {
        setAudioAttributes(alarmAttributes)
        setDataSource(context, CrashMonitorService.alarmSound(context))
        isLooping = true
        setVolume(1f, 1f)
        prepare()
        start()
      }
    }.getOrNull()
  }

  private fun releasePlayer() {
    player?.let { runCatching { it.stop() }; runCatching { it.release() } }
    player = null
  }

  private fun audio(context: Context) = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private fun notifications(context: Context) = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun forceVolume(context: Context) {
    val manager = audio(context)
    val max = manager.getStreamMaxVolume(AudioManager.STREAM_ALARM)
    val current = manager.getStreamVolume(AudioManager.STREAM_ALARM)
    if (savedVolume < 0) savedVolume = current
    if (current < max) runCatching { manager.setStreamVolume(AudioManager.STREAM_ALARM, max, 0) }
  }

  private fun restoreVolume(context: Context) {
    if (savedVolume >= 0) runCatching { audio(context).setStreamVolume(AudioManager.STREAM_ALARM, savedVolume, 0) }
    savedVolume = -1
  }

  private fun overrideDnd(context: Context) {
    if (Build.VERSION.SDK_INT < 23) return
    val manager = notifications(context)
    if (!manager.isNotificationPolicyAccessGranted) return
    val filter = manager.currentInterruptionFilter
    if (filter != NotificationManager.INTERRUPTION_FILTER_ALL) {
      savedFilter = filter
      runCatching { manager.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL) }
    }
  }

  private fun restoreDnd(context: Context) {
    if (Build.VERSION.SDK_INT < 23 || savedFilter < 0) return
    val manager = notifications(context)
    if (manager.isNotificationPolicyAccessGranted) runCatching { manager.setInterruptionFilter(savedFilter) }
    savedFilter = -1
  }

  @Suppress("DEPRECATION")
  private fun requestFocus(context: Context) {
    val manager = audio(context)
    if (Build.VERSION.SDK_INT >= 26) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(alarmAttributes)
        .setOnAudioFocusChangeListener { }
        .build()
      focus = request
      manager.requestAudioFocus(request)
    } else {
      manager.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
    }
  }

  @Suppress("DEPRECATION")
  private fun abandonFocus(context: Context) {
    val manager = audio(context)
    if (Build.VERSION.SDK_INT >= 26) focus?.let { manager.abandonAudioFocusRequest(it) } else manager.abandonAudioFocus(null)
    focus = null
  }

  @Suppress("DEPRECATION")
  private fun vibrator(context: Context): Vibrator? =
    if (Build.VERSION.SDK_INT >= 31) {
      (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

  @Suppress("DEPRECATION")
  private fun vibrate(context: Context) {
    val vibrator = vibrator(context) ?: return
    val pattern = longArrayOf(0, 900, 450)
    runCatching {
      when {
        Build.VERSION.SDK_INT >= 33 -> vibrator.vibrate(
          VibrationEffect.createWaveform(pattern, 0),
          VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM),
        )
        Build.VERSION.SDK_INT >= 26 -> vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), alarmAttributes)
        else -> vibrator.vibrate(pattern, 0)
      }
    }
  }
}
