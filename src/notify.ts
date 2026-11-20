import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

type NotificationsModule = typeof import('expo-notifications');

let modulePromise: Promise<NotificationsModule> | null = null;
let channelsReady: Promise<void> | null = null;

/** Expo Go cannot bundle the custom siren into a notification channel; standalone builds can. */
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/**
 * Android channel settings are immutable once created, so the channel id encodes the sound
 * it uses. Builds made with `eas build` / `expo run` ship assets/sounds/crash_alarm.wav via the
 * expo-notifications config plugin; Expo Go falls back to the system default sound.
 */
const ALARM_CHANNEL_ID = isExpoGo ? 'crash-alarm-default-v1' : 'crash-alarm-siren-v2';
const GENERAL_CHANNEL_ID = 'incident-alerts';

async function notifications() {
  if (!modulePromise) {
    modulePromise = import('expo-notifications').then((Notifications) => {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          // On Android, shouldPlaySound:false also suppresses the heads-up banner, so it must be true.
          shouldPlaySound: true,
          shouldSetBadge: false,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      });
      return Notifications;
    });
  }
  return modulePromise;
}

async function ensureChannels(Notifications: NotificationsModule) {
  if (Platform.OS !== 'android') return;
  if (!channelsReady) {
    channelsReady = (async () => {
      await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
        name: 'Crash alarm',
        description: 'Loud, persistent alarm when a crash involving your vehicle or jurisdiction is reported.',
        importance: Notifications.AndroidImportance.MAX,
        sound: isExpoGo ? 'default' : 'crash_alarm.wav',
        vibrationPattern: [0, 1000, 500, 1000, 500, 1000],
        enableVibrate: true,
        bypassDnd: true,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      await Notifications.setNotificationChannelAsync(GENERAL_CHANNEL_ID, {
        name: 'Account and incident updates',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 400, 250, 400],
      });
    })().catch((error: unknown) => {
      channelsReady = null;
      throw error;
    });
  }
  await channelsReady;
}

/** Channels must exist before the Android 13+ permission prompt is shown. */
export async function requestNotificationPermission() {
  if (Platform.OS === 'web') return false;
  const Notifications = await notifications();
  await ensureChannels(Notifications);
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).status === 'granted';
}

export async function sendLocalNotification(title: string, body: string) {
  if (Platform.OS === 'web') return;
  if (!(await requestNotificationPermission())) throw new Error('Notification permission was not granted.');
  const Notifications = await notifications();
  await Notifications.scheduleNotificationAsync({
    content: { title, body, sound: true },
    trigger: Platform.OS === 'android' ? { channelId: GENERAL_CHANNEL_ID } : null,
  });
}

/**
 * Shows a sticky, maximum-priority alarm notification (cannot be swiped away on Android) so the
 * alarm is visible from the lock screen and other apps. Returns its identifier for dismissal.
 */
export async function showAlarmNotification(title: string, body: string, data: Record<string, unknown>) {
  if (Platform.OS === 'web') return null;
  if (!(await requestNotificationPermission())) return null;
  const Notifications = await notifications();
  return Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sticky: true,
      autoDismiss: false,
      priority: Notifications.AndroidNotificationPriority.MAX,
      sound: isExpoGo ? true : 'crash_alarm.wav',
      vibrate: [0, 1000, 500, 1000],
      color: '#D92D20',
    },
    trigger: Platform.OS === 'android' ? { channelId: ALARM_CHANNEL_ID } : null,
  });
}

export async function dismissNotification(identifier: string | null | undefined) {
  if (!identifier || Platform.OS === 'web') return;
  const Notifications = await notifications();
  await Notifications.dismissNotificationAsync(identifier);
}
