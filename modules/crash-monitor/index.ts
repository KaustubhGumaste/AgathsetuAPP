import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type CrashMonitorStatus = {
  enabled: boolean;
  running: boolean;
  notificationsAllowed: boolean;
  fullScreenAllowed: boolean;
  batteryUnrestricted: boolean;
};

type NativeCrashMonitor = {
  start(baseUrl: string, token: string, mode: 'citizen' | 'authority', path: string, intervalMs: number): boolean;
  stop(): void;
  cancelAlarm(): void;
  status(): CrashMonitorStatus;
  openFullScreenSettings(): void;
  requestBatteryExemption(): void;
  setShowOverLockScreen(show: boolean): void;
};

/** Null in Expo Go and on web: the background monitor exists only in the installed Android app. */
const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeCrashMonitor>('CrashMonitor') : null;

export const crashMonitorAvailable = native !== null;

function safely<T>(action: () => T, fallback: T): T {
  if (!native) return fallback;
  try {
    return action();
  } catch {
    return fallback;
  }
}

export const CrashMonitor = {
  start: (baseUrl: string, token: string, mode: 'citizen' | 'authority', path: string, intervalMs = 5000) =>
    safely(() => native!.start(baseUrl, token, mode, path, intervalMs), false),
  stop: () => safely(() => native!.stop(), undefined),
  cancelAlarm: () => safely(() => native!.cancelAlarm(), undefined),
  status: (): CrashMonitorStatus | null => safely(() => native!.status(), null),
  openFullScreenSettings: () => safely(() => native!.openFullScreenSettings(), undefined),
  requestBatteryExemption: () => safely(() => native!.requestBatteryExemption(), undefined),
  setShowOverLockScreen: (show: boolean) => safely(() => native!.setShowOverLockScreen(show), undefined),
};
