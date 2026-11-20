import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export type CrashMonitorStatus = {
  enabled: boolean;
  running: boolean;
  notificationsAllowed: boolean;
  fullScreenAllowed: boolean;
  batteryUnrestricted: boolean;
  /** Do Not Disturb access: lets the siren switch DND off while a crash alarm is sounding. */
  dndAccess: boolean;
};

/** The citizen alarm being counted down (shared with the background service). */
export type CrashAlarmState = {
  incidentId: string;
  /** Epoch milliseconds; 0 when no citizen alarm is being counted down. */
  startedAt: number;
  /** Already reported to the server as a severe accident because nobody answered in time. */
  reported: boolean;
  timeoutMs: number;
};

type NativeCrashMonitor = {
  start(baseUrl: string, token: string, mode: 'citizen' | 'authority', path: string, intervalMs: number): boolean;
  stop(): void;
  cancelAlarm(): void;
  startAlarm(incidentId: string): CrashAlarmState;
  alarmState(): CrashAlarmState;
  markAlarmReported(incidentId: string): void;
  endAlarm(): void;
  stopSiren(): void;
  setSirenMuted(muted: boolean): void;
  openDndSettings(): void;
  status(): CrashMonitorStatus;
  openFullScreenSettings(): void;
  requestBatteryExemption(): void;
  setShowOverLockScreen(show: boolean): void;
};

/** Null in Expo Go and on web: the background monitor exists only in the installed Android app. */
const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeCrashMonitor>('CrashMonitor') : null;

export const crashMonitorAvailable = native !== null;

/** Seconds a citizen has to answer the crash alarm before it is reported as a severe accident. */
export const ANSWER_TIMEOUT_MS = 30_000;

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
  /** Starts the native siren; with an incident id also the shared answer countdown. Null without the native module. */
  startAlarm: (incidentId = ''): CrashAlarmState | null => safely(() => native!.startAlarm(incidentId), null),
  alarmState: (): CrashAlarmState | null => safely(() => native!.alarmState(), null),
  markAlarmReported: (incidentId: string) => safely(() => native!.markAlarmReported(incidentId), undefined),
  endAlarm: () => safely(() => native!.endAlarm(), undefined),
  stopSiren: () => safely(() => native!.stopSiren(), undefined),
  setSirenMuted: (muted: boolean) => safely(() => native!.setSirenMuted(muted), undefined),
  openDndSettings: () => safely(() => native!.openDndSettings(), undefined),
  status: (): CrashMonitorStatus | null => safely(() => native!.status(), null),
  openFullScreenSettings: () => safely(() => native!.openFullScreenSettings(), undefined),
  requestBatteryExemption: () => safely(() => native!.requestBatteryExemption(), undefined),
  setShowOverLockScreen: (show: boolean) => safely(() => native!.setShowOverLockScreen(show), undefined),
};
