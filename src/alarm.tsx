import React, { useEffect, useRef, useState } from 'react';
import { type AudioPlayer, createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  Animated,
  AppState,
  BackHandler,
  Easing,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CrashMonitor, crashMonitorAvailable } from '../modules/crash-monitor';
import { dismissNotification, showAlarmNotification } from './notify';

const ALARM_SOUND = require('../assets/sounds/crash_alarm.wav');
const KEEP_AWAKE_TAG = 'aghat-sethu-crash-alarm';
// Vibrate 0.9 s, pause 0.45 s, repeated until Vibration.cancel() is called.
const VIBRATION_PATTERN = [0, 900, 450];

/**
 * Drives the physical alarm: looping siren, continuous vibration, screen kept awake and a sticky
 * notification. Everything runs until `active` becomes false — i.e. until the person explicitly
 * answers or acknowledges the alarm.
 *
 * In the installed Android app the siren is native (modules/crash-monitor CrashSiren): it plays on
 * the ALARM stream, forces the alarm volume to maximum, plays in silent/vibrate mode and, with Do Not
 * Disturb access, through DND. Elsewhere (Expo Go, iOS) an expo-audio siren is the fallback.
 * `soundMuted` only pauses the sound (while dialling emergency services); the popup, vibration and
 * notification stay until the alarm is turned off. `citizenIncidentId` marks a citizen crash alarm,
 * whose end also clears the shared 30-second answer countdown.
 */
export function useCrashAlarm({
  active,
  soundMuted = false,
  citizenIncidentId = '',
  title,
  body,
  data,
}: {
  active: boolean;
  soundMuted?: boolean;
  citizenIncidentId?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}) {
  const citizenRef = useRef(citizenIncidentId);
  useEffect(() => {
    citizenRef.current = citizenIncidentId;
  }, [citizenIncidentId]);

  // Native siren: started while active, stopped when the alarm is answered or acknowledged.
  // (A citizen alarm's countdown was already started by raiseCitizenAlarm; this only adds the siren.)
  useEffect(() => {
    if (!crashMonitorAvailable || !active) return undefined;
    CrashMonitor.startAlarm('');
    return () => {
      if (citizenRef.current) CrashMonitor.endAlarm();
      else CrashMonitor.stopSiren();
    };
  }, [active]);

  useEffect(() => {
    if (!crashMonitorAvailable || !active) return;
    CrashMonitor.setSirenMuted(soundMuted);
  }, [active, soundMuted]);

  const player = useRef<AudioPlayer | null>(null);
  const notificationId = useRef<string | null>(null);
  const latest = useRef({ title, body, data });

  useEffect(() => {
    latest.current = { title, body, data };
  }, [title, body, data]);

  // Fallback siren (no native module): one player for the lifetime of the screen, released on unmount.
  useEffect(() => {
    if (crashMonitorAvailable) return undefined;
    const created = createAudioPlayer(ALARM_SOUND);
    created.loop = true;
    created.volume = 1;
    player.current = created;
    return () => {
      player.current = null;
      try {
        created.pause();
        created.remove();
      } catch {
        // already released
      }
    };
  }, []);

  // Siren
  useEffect(() => {
    const siren = player.current;
    if (!siren) return undefined;
    if (!active || soundMuted) {
      try {
        siren.pause();
      } catch {
        // player already released
      }
      return undefined;
    }
    let cancelled = false;
    const start = async () => {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          interruptionMode: 'doNotMix',
        });
      } catch {
        // Audio mode is best-effort; playback below still runs in the foreground.
      }
      if (cancelled) return;
      await siren.seekTo(0).catch(() => undefined);
      if (!cancelled) siren.play();
    };
    void start();
    // Some Android versions pause audio when the app is backgrounded/foregrounded; resume it.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !cancelled) siren.play();
    });
    return () => {
      cancelled = true;
      subscription.remove();
      try {
        siren.pause();
      } catch {
        // player already released
      }
    };
  }, [active, soundMuted]);

  // Vibration, keep-awake and the sticky notification
  useEffect(() => {
    if (!active) return undefined;
    // The native siren vibrates as an alarm itself (it keeps going on silent and vibrate-off settings).
    if (!crashMonitorAvailable) Vibration.vibrate(Platform.OS === 'android' ? VIBRATION_PATTERN : 1000, true);
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    let cancelled = false;
    void showAlarmNotification(latest.current.title, latest.current.body, latest.current.data ?? {})
      .then((identifier) => {
        if (cancelled) void dismissNotification(identifier).catch(() => undefined);
        else notificationId.current = identifier;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      Vibration.cancel();
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
      void dismissNotification(notificationId.current).catch(() => undefined);
      notificationId.current = null;
    };
  }, [active]);
}

/**
 * Full-screen alarm popup. It cannot be dismissed with the Android back button or by tapping
 * outside; it closes only through one of the explicit actions passed as children.
 */
export function AlarmPopup({
  visible,
  badge,
  title,
  message,
  details,
  children,
}: {
  visible: boolean;
  badge: string;
  title: string;
  message: string;
  details?: React.ReactNode;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const [pulse] = useState(() => new Animated.Value(0));

  // Block the Android back button/gesture at the activity level too (Android 16 predictive back can
  // bypass the Modal's own onRequestClose), so the alarm cannot be backed out of or minimised by mistake.
  useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 650, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, visible]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0.35] });

  return (
    <Modal
      animationType="fade"
      hardwareAccelerated
      navigationBarTranslucent
      onRequestClose={() => {
        // Intentionally ignored: the alarm must be answered, not dismissed with the back button.
      }}
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
      visible={visible}
    >
      <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <ScrollView
          bounces={false}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.iconWrap}>
            <Animated.View style={[styles.ring, { opacity: ringOpacity, transform: [{ scale: ringScale }] }]} />
            <View style={styles.icon}>
              <Text style={styles.iconText}>!</Text>
            </View>
          </View>
          <Text style={styles.badge}>{badge}</Text>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          {details ? <View style={styles.details}>{details}</View> : null}
          <View style={styles.actions}>{children}</View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#7A0F09', flex: 1 },
  content: { alignItems: 'stretch', flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22 },
  iconWrap: { alignItems: 'center', alignSelf: 'center', height: 112, justifyContent: 'center', width: 112 },
  ring: { backgroundColor: '#F04438', borderRadius: 56, height: 112, position: 'absolute', width: 112 },
  icon: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 40, height: 80, justifyContent: 'center', width: 80 },
  iconText: { color: '#B42318', fontSize: 46, fontWeight: '900', lineHeight: 52 },
  badge: {
    alignSelf: 'center',
    backgroundColor: '#FEE4E2',
    borderRadius: 999,
    color: '#912018',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginTop: 20,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  title: { color: '#FFFFFF', fontSize: 28, fontWeight: '900', lineHeight: 34, marginTop: 14, textAlign: 'center' },
  message: { color: '#FEE4E2', fontSize: 15, lineHeight: 22, marginTop: 10, textAlign: 'center' },
  details: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 14, marginTop: 18, padding: 14 },
  actions: { gap: 10, marginTop: 22 },
});
