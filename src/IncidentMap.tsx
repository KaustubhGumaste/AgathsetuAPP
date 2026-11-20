import Constants from 'expo-constants';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import { ApiError, type ApiClient, asRecord, displayDate } from './api';
import { type Coordinates, distanceMeters, formatDistance, useWatchedPosition } from './location';
import { type Palette, colors, themedStyles, useSettings } from './settings';

/**
 * Responder map: every open crash as a marker; for the selected crash, the crash point, the live
 * phone position of the people involved, this officer's position and the driving route between them.
 *
 * Android with GOOGLE_MAPS_ANDROID_API_KEY in the build: native Google Maps (expo-maps).
 * Otherwise (no key, iOS, Expo Go): Google Maps embedded in a web view, which needs no key.
 */

type MapIncident = {
  id: string;
  junction: string;
  severity: string;
  occurredAt: unknown;
  location: (Coordinates & { source: string }) | null;
};

type LiveLocation = Coordinates & {
  name: string | null;
  mobile: string | null;
  accuracy: number | null;
  updatedAt: string | null;
  stale: boolean;
};

type Route = { points: Coordinates[]; distance: number; duration: number } | null;

type GoogleMapsModule = typeof import('expo-maps');
let mapsModule: GoogleMapsModule | null | undefined;
function nativeMaps(): GoogleMapsModule | null {
  if (mapsModule !== undefined) return mapsModule;
  const keyInBuild = Constants.expoConfig?.extra?.googleMapsConfigured === true;
  if (Platform.OS !== 'android' || !keyInBuild) {
    mapsModule = null;
    return mapsModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mapsModule = require('expo-maps') as GoogleMapsModule;
  } catch {
    mapsModule = null;
  }
  return mapsModule;
}

function coordinates(value: unknown): Coordinates | null {
  const record = asRecord(value);
  const latitude = Number(record.latitude);
  const longitude = Number(record.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (record.latitude === null || record.longitude === null) return null;
  return { latitude, longitude };
}

export function mapIncident(value: unknown): MapIncident {
  const record = asRecord(value);
  const location = coordinates(record.location);
  return {
    id: String(record.incident_id ?? record.id ?? ''),
    junction: String(record.junction_id ?? record.junction ?? '—'),
    severity: String(record.severity ?? 'unknown'),
    occurredAt: record.occurred_at ?? record.time,
    location: location ? { ...location, source: String(asRecord(record.location).source ?? 'junction') } : null,
  };
}

/** "minor" / "major" style label for a severity value (text or a 0–1 confidence). */
export function severityLabel(value: unknown) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'unknown' || text === '—') return 'Unknown severity';
  const number = Number(text);
  if (Number.isFinite(number)) return number >= 0.7 ? 'Major' : 'Minor';
  if (/(major|severe|high|critical|fatal)/.test(text)) return 'Major';
  if (/(minor|low|light|moderate|medium)/.test(text)) return 'Minor';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Google encoded polyline → coordinates. */
function decodePolyline(encoded: string): Coordinates[] {
  const points: Coordinates[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

function navigateTo(target: Coordinates) {
  const destination = `${target.latitude},${target.longitude}`;
  const web = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
  const native = Platform.OS === 'android' ? `google.navigation:q=${destination}&mode=d` : web;
  void Linking.openURL(native).catch(() => Linking.openURL(web));
}

function ago(iso: string | null) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

export function IncidentMap({
  api,
  incidents,
  selectedId,
  onSelect,
  onOpenEvidence,
}: {
  api: ApiClient;
  incidents: unknown[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenEvidence: (id: string) => void;
}) {
  const { scheme } = useSettings();
  const { height } = useWindowDimensions();
  const items = useMemo(() => incidents.map(mapIncident).filter((item) => item.id), [incidents]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  // Per-incident results: switching crashes never shows the previous crash's people or route.
  const [liveFor, setLiveFor] = useState<{ id: string; list: LiveLocation[]; error: string }>({ id: '', list: [], error: '' });
  const [routeFor, setRouteFor] = useState<{ id: string; route: Route; note: string }>({ id: '', route: null, note: '' });
  const live = liveFor.id === selected?.id ? liveFor.list : [];
  const liveError = liveFor.id === selected?.id ? liveFor.error : '';
  const route = routeFor.id === selected?.id ? routeFor.route : null;
  const routeNote = routeFor.id === selected?.id ? routeFor.note : '';
  const me = useWatchedPosition(Platform.OS !== 'web');
  const mapRef = useRef<{ setCameraPosition?: (config: object) => Promise<void> } | null>(null);
  const routeFrom = useRef<{ id: string; at: Coordinates } | null>(null);
  const routeUnavailable = useRef(false);

  // Live position of the people involved, refreshed every 5 s.
  useEffect(() => {
    if (!selected) return undefined;
    const id = selected.id;
    let active = true;
    const load = async () => {
      try {
        const response = asRecord(await api.get<unknown>(`/api/incidents/${encodeURIComponent(selected.id)}/location`));
        if (!active) return;
        const list = Array.isArray(response.live_locations) ? response.live_locations : [];
        setLiveFor({ id, error: '', list: list.flatMap((entry) => {
          const record = asRecord(entry);
          const point = coordinates(record);
          return point ? [{
            ...point,
            name: typeof record.name === 'string' ? record.name : null,
            mobile: typeof record.mobile === 'string' ? record.mobile : null,
            accuracy: typeof record.accuracy_m === 'number' ? record.accuracy_m : null,
            updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
            stale: record.stale === true,
          }] : [];
        }) });
      } catch (error) {
        if (!active) return;
        // An older server without the live-location endpoint: show the crash point only.
        const message = error instanceof ApiError && error.status === 404
          ? ''
          : error instanceof Error ? error.message : 'Could not refresh live location.';
        setLiveFor((current) => ({ id, list: current.id === id ? current.list : [], error: message }));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const freshLive = live.find((item) => !item.stale) ?? null;
  const target: Coordinates | null = freshLive ?? live[0] ?? selected?.location ?? null;
  const myPosition = me.position;

  // Driving route from the server (Google Routes API); refreshed when the officer moves 150 m.
  useEffect(() => {
    if (!selected || !myPosition || !target || routeUnavailable.current) return;
    const id = selected.id;
    if (routeFrom.current?.id === id && distanceMeters(routeFrom.current.at, myPosition) < 150) return;
    routeFrom.current = { id, at: { latitude: myPosition.latitude, longitude: myPosition.longitude } };
    let active = true;
    void api.get<unknown>(
      `/api/incidents/${encodeURIComponent(selected.id)}/route?from_lat=${myPosition.latitude}&from_lng=${myPosition.longitude}`,
    ).then((response) => {
      if (!active) return;
      const record = asRecord(response);
      const points = typeof record.encoded_polyline === 'string' ? decodePolyline(record.encoded_polyline) : [];
      setRouteFor({
        id,
        note: '',
        route: points.length > 1 ? { points, distance: Number(record.distance_m) || 0, duration: Number(record.duration_s) || 0 } : null,
      });
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && (error.status === 503 || error.status === 404)) {
        routeUnavailable.current = true; // not configured: straight line + Google Maps navigation instead
        setRouteFor({ id, route: null, note: 'Road routes are not configured on the server; the red line shows the straight-line direction.' });
      } else {
        routeFrom.current = null; // retry on the next position update
        setRouteFor({ id, route: null, note: error instanceof Error ? error.message : 'Could not load the route.' });
      }
    });
    return () => { active = false; };
  }, [api, myPosition, selected, target]);

  // Move the camera to the selected crash.
  useEffect(() => {
    if (!selected?.location) return;
    void mapRef.current?.setCameraPosition?.({ coordinates: selected.location, zoom: 15, duration: 600 })?.catch?.(() => undefined);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (items.length === 0) return null;

  const straightDistance = myPosition && target ? distanceMeters(myPosition, target) : null;
  const mapHeight = Math.max(320, Math.round(height * 0.55));
  const native = nativeMaps();

  let map: React.ReactNode;
  if (native) {
    const { GoogleMaps } = native;
    const markers = [
      ...items.filter((item) => item.location).map((item) => ({
        id: `incident-${item.id}`,
        coordinates: item.location!,
        title: `Crash · Junction ${item.junction}`,
        snippet: `${severityLabel(item.severity)} · ${displayDate(item.occurredAt)}`,
        showCallout: item.id === selected?.id,
        zIndex: item.id === selected?.id ? 2 : 1,
      })),
      ...live.map((item, index) => ({
        id: `live-${index}`,
        coordinates: { latitude: item.latitude, longitude: item.longitude },
        title: `${item.name ?? 'Person involved'} (live)`,
        snippet: `Updated ${ago(item.updatedAt)}${item.stale ? ' · may be outdated' : ''}`,
        zIndex: 3,
      })),
    ];
    const circles = [
      ...(selected?.location ? [{ id: 'crash-zone', center: selected.location, radius: 60, color: 'rgba(217,45,32,0.18)', lineColor: '#D92D20', lineWidth: 2 }] : []),
      ...live.filter((item) => item.accuracy).map((item, index) => ({
        id: `accuracy-${index}`,
        center: { latitude: item.latitude, longitude: item.longitude },
        radius: Math.min(item.accuracy ?? 0, 500),
        color: 'rgba(23,92,211,0.15)',
        lineColor: '#175CD3',
        lineWidth: 1,
      })),
    ];
    const polylines = route
      ? [{ id: 'route', coordinates: route.points, color: '#175CD3', width: 8 }]
      : myPosition && target
        ? [{ id: 'direction', coordinates: [myPosition, target], color: '#D92D20', width: 4, geodesic: true }]
        : [];
    map = (
      <GoogleMaps.View
        cameraPosition={{ coordinates: selected?.location ?? items.find((item) => item.location)?.location ?? undefined, zoom: 14 }}
        circles={circles}
        colorScheme={scheme === 'dark' ? GoogleMaps.MapColorScheme.DARK : GoogleMaps.MapColorScheme.LIGHT}
        markers={markers}
        onMarkerClick={(marker) => {
          const id = String(marker.id ?? '');
          if (id.startsWith('incident-')) onSelect(id.slice('incident-'.length));
        }}
        polylines={polylines}
        properties={{ isMyLocationEnabled: me.status === 'watching', isTrafficEnabled: true }}
        ref={mapRef as never}
        style={styles.fill}
        uiSettings={{ compassEnabled: true, myLocationButtonEnabled: true, zoomControlsEnabled: true, mapToolbarEnabled: false }}
      />
    );
  } else if (Platform.OS !== 'web' && target) {
    // No Maps SDK key in this build: Google Maps' own embeddable page (keyless), showing the target.
    const query = `${target.latitude},${target.longitude}`;
    const uri = myPosition
      ? `https://maps.google.com/maps?saddr=${myPosition.latitude},${myPosition.longitude}&daddr=${query}&output=embed`
      : `https://maps.google.com/maps?q=${query}&z=16&output=embed`;
    map = <WebView originWhitelist={['https://*']} source={{ uri }} startInLoadingState style={styles.fill} />;
  } else {
    map = (
      <View style={[styles.fill, styles.mapMissing]}>
        <Text style={styles.mutedText}>{target ? 'The map opens in Google Maps on this device.' : 'This crash has no known location yet.'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.stack}>
      <View style={[styles.mapFrame, { height: mapHeight }]}>{map}</View>

      {items.length > 1 ? (
        <View style={styles.chips}>
          {items.map((item) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: item.id === selected?.id }}
              key={item.id}
              onPress={() => onSelect(item.id)}
              style={[styles.chip, item.id === selected?.id && styles.chipActive]}
            >
              <Text style={[styles.chipText, item.id === selected?.id && styles.chipTextActive]}>
                {item.junction} · {severityLabel(item.severity)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {selected ? (
        <View style={styles.panel}>
          <View style={styles.row}>
            <Text style={styles.title}>Crash at junction {selected.junction}</Text>
            <Text style={[styles.badge, severityLabel(selected.severity) === 'Major' ? styles.badgeMajor : styles.badgeMinor]}>
              {severityLabel(selected.severity)}
            </Text>
          </View>
          <Text style={styles.mutedText}>Reported {displayDate(selected.occurredAt)}</Text>
          <Text style={styles.bodyText}>
            {selected.location
              ? selected.location.source === 'junction'
                ? `Crash point: junction position (${selected.location.latitude.toFixed(5)}, ${selected.location.longitude.toFixed(5)}).`
                : `Crash point reported by the detector (${selected.location.latitude.toFixed(5)}, ${selected.location.longitude.toFixed(5)}).`
              : 'The crash report did not include a location.'}
          </Text>
          {live.length > 0 ? live.map((item, index) => (
            <Text key={index} style={[styles.bodyText, item.stale && styles.warnText]}>
              ● {item.name ?? 'Person involved'}: live phone location, updated {ago(item.updatedAt)}
              {item.accuracy ? ` (±${Math.round(item.accuracy)} m)` : ''}{item.stale ? ' — may be outdated' : ''}
            </Text>
          )) : <Text style={styles.mutedText}>No live phone location from the people involved yet.</Text>}
          {liveError ? <Text style={styles.warnText}>{liveError}</Text> : null}

          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{route ? formatDistance(route.distance) : straightDistance !== null ? formatDistance(straightDistance) : '—'}</Text>
              <Text style={styles.statLabel}>{route ? 'by road' : 'straight line'}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{route ? `${Math.max(1, Math.round(route.duration / 60))} min` : '—'}</Text>
              <Text style={styles.statLabel}>drive time (traffic)</Text>
            </View>
          </View>
          {me.status === 'asking' ? <ActivityIndicator color={colors.primary} /> : null}
          {me.status === 'denied' ? <Text style={styles.warnText}>Allow location access to see your position and the route.</Text> : null}
          {me.status === 'error' ? <Text style={styles.warnText}>{me.error}</Text> : null}
          {routeNote ? <Text style={styles.mutedText}>{routeNote}</Text> : null}

          <View style={styles.actions}>
            {target ? (
              <Pressable accessibilityRole="button" onPress={() => navigateTo(target)} style={[styles.action, styles.actionPrimary]}>
                <Text style={styles.actionText}>Navigate (turn-by-turn)</Text>
              </Pressable>
            ) : null}
            {live.find((item) => item.mobile) ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void Linking.openURL(`tel:${live.find((item) => item.mobile)!.mobile}`)}
                style={[styles.action, styles.actionDanger]}
              >
                <Text style={styles.actionText}>Call person involved</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => onOpenEvidence(selected.id)} style={[styles.action, styles.actionSecondary]}>
              <Text style={styles.actionTextSecondary}>Incident evidence</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = themedStyles((c: Palette) => StyleSheet.create({
  stack: { gap: 12 },
  fill: { flex: 1 },
  mapFrame: { backgroundColor: c.surfaceMuted, borderColor: c.border, borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  mapMissing: { alignItems: 'center', justifyContent: 'center', padding: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderColor: c.borderStrong, borderRadius: 999, borderWidth: 1, minHeight: 36, justifyContent: 'center', paddingHorizontal: 12 },
  chipActive: { backgroundColor: c.primarySoft, borderColor: c.primary },
  chipText: { color: c.textBody, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: c.primaryDark },
  panel: { backgroundColor: c.surface, borderColor: c.border, borderRadius: 16, borderWidth: 1, gap: 4, padding: 16 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  title: { color: c.text, flexShrink: 1, fontSize: 17, fontWeight: '800' },
  badge: { borderRadius: 999, fontSize: 11, fontWeight: '900', overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 4, textTransform: 'uppercase' },
  badgeMajor: { backgroundColor: c.dangerSoft, color: c.danger },
  badgeMinor: { backgroundColor: c.warningSoft, color: c.warning },
  bodyText: { color: c.textBody, fontSize: 14, lineHeight: 20, marginTop: 4 },
  mutedText: { color: c.textMuted, fontSize: 13, lineHeight: 19, marginTop: 2 },
  warnText: { color: c.warning, fontSize: 13, lineHeight: 19, marginTop: 4 },
  statRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  stat: { backgroundColor: c.surfaceMuted, borderColor: c.border, borderRadius: 12, borderWidth: 1, flex: 1, padding: 12 },
  statValue: { color: c.primaryDark, fontSize: 20, fontWeight: '900' },
  statLabel: { color: c.textMuted, fontSize: 12, marginTop: 2 },
  actions: { gap: 8, marginTop: 12 },
  action: { alignItems: 'center', borderRadius: 12, justifyContent: 'center', minHeight: 48, paddingHorizontal: 16 },
  actionPrimary: { backgroundColor: c.primary },
  actionDanger: { backgroundColor: '#D92D20' },
  actionSecondary: { backgroundColor: c.surface, borderColor: c.borderStrong, borderWidth: 1 },
  actionText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  actionTextSecondary: { color: c.textStrong, fontSize: 15, fontWeight: '800' },
}));
