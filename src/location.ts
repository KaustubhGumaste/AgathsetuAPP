import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { ApiError, type ApiClient } from './api';

export type Coordinates = { latitude: number; longitude: number };

export type WatchState = {
  status: 'off' | 'asking' | 'denied' | 'watching' | 'error';
  position: (Coordinates & { accuracy: number | null; at: number }) | null;
  error: string;
};

/**
 * Follows this phone's position while `enabled` (foreground only). Asks for location permission the
 * first time; `denied` means the person refused it.
 */
export function useWatchedPosition(enabled: boolean, accuracy = Location.Accuracy.High): WatchState {
  const [state, setState] = useState<WatchState>({ status: 'off', position: null, error: '' });

  useEffect(() => {
    if (!enabled) {
      setState((current) => (current.status === 'off' ? current : { status: 'off', position: current.position, error: '' }));
      return undefined;
    }
    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    const start = async () => {
      setState((current) => ({ ...current, status: 'asking', error: '' }));
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (permission.status !== 'granted') {
          setState((current) => ({ ...current, status: 'denied', error: 'Location permission was not given.' }));
          return;
        }
        const onPosition = (location: Location.LocationObject) => {
          if (cancelled) return;
          setState({
            status: 'watching',
            error: '',
            position: {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              accuracy: location.coords.accuracy ?? null,
              at: location.timestamp,
            },
          });
        };
        // A quick first fix, then continuous updates.
        const last = await Location.getLastKnownPositionAsync().catch(() => null);
        if (last) onPosition(last);
        subscription = await Location.watchPositionAsync(
          { accuracy, distanceInterval: 10, timeInterval: 5000 },
          onPosition,
          (reason) => { if (!cancelled) setState((current) => ({ ...current, status: 'error', error: reason })); },
        );
        if (cancelled) subscription.remove();
      } catch (reason) {
        if (!cancelled) {
          setState((current) => ({
            ...current,
            status: 'error',
            error: reason instanceof Error ? reason.message : 'Could not read this phone\'s location.',
          }));
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [accuracy, enabled]);

  return state;
}

export type ShareState = WatchState & {
  lastSentAt: number | null;
  /** Set when the server stopped accepting positions (incident resolved or no longer visible). */
  stopped: string;
};

const SEND_EVERY_MS = 5000;
const HEARTBEAT_MS = 30000;

/**
 * While a crash involving this citizen is open, sends the phone's live position to the server so
 * responders can find them. Sends at most every 5 s while moving, and every 30 s when still so the
 * responder map does not mark the position as stale.
 */
export function useCrashLocationShare(api: ApiClient, incidentId: string, enabled: boolean): ShareState {
  // Kept per incident, so a new crash starts with a clean state.
  const [stoppedFor, setStoppedFor] = useState({ id: '', reason: '' });
  const [sentFor, setSentFor] = useState<{ id: string; at: number | null }>({ id: '', at: null });
  const stopped = stoppedFor.id === incidentId ? stoppedFor.reason : '';
  const lastSentAt = sentFor.id === incidentId ? sentFor.at : null;
  const active = enabled && Boolean(incidentId) && Platform.OS !== 'web' && !stopped;
  const watch = useWatchedPosition(active, Location.Accuracy.Highest);
  const position = watch.position;
  const sending = useRef(false);

  useEffect(() => {
    if (!active) return undefined;
    const sinceLastSend = () => Date.now() - (lastSentAt ?? 0);
    const send = async (force: boolean) => {
      if (!position || sending.current) return;
      if (!force && sinceLastSend() < SEND_EVERY_MS) return;
      sending.current = true;
      try {
        await api.shareIncidentLocation(incidentId, {
          latitude: position.latitude,
          longitude: position.longitude,
          accuracy_m: position.accuracy === null ? null : Math.round(position.accuracy * 10) / 10,
        });
        setSentFor({ id: incidentId, at: Date.now() });
      } catch (error) {
        if (error instanceof ApiError && (error.status === 409 || error.status === 404 || error.status === 403)) {
          setStoppedFor({ id: incidentId, reason: error.message });
        }
        // Network errors: try again on the next position or heartbeat.
      } finally {
        sending.current = false;
      }
    };
    void send(false);
    const heartbeat = setInterval(() => void send(sinceLastSend() >= HEARTBEAT_MS), SEND_EVERY_MS);
    const appState = AppState.addEventListener('change', (next) => { if (next === 'active') void send(true); });
    return () => {
      clearInterval(heartbeat);
      appState.remove();
    };
  }, [active, api, incidentId, lastSentAt, position]);

  return { ...watch, lastSentAt, stopped };
}

/** Straight-line distance in metres. */
export function distanceMeters(a: Coordinates, b: Coordinates) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(h));
}

export function formatDistance(meters: number) {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}
