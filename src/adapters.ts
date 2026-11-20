/**
 * Two AGHAT SETHU backends exist:
 *  - "mainapp": the FastAPI service in backend/ (websocket tickets, crash confirmations, admin approvals…)
 *  - "portal":  the service behind the public web portal (e.g. https://aghatsethu.duckdns.org).
 * The screens are written against the mainapp shapes; responses from the portal are converted here.
 * Every function is defensive: an unexpected shape passes through unchanged rather than throwing.
 */

export type Dialect = 'mainapp' | 'portal';

type Rec = Record<string, unknown>;

const rec = (value: unknown): Rec =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const firstList = (value: unknown, ...keys: string[]): unknown[] => {
  if (Array.isArray(value)) return value;
  const record = rec(value);
  for (const key of [...keys, 'items', 'results', 'data']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      const nested = firstList(candidate, ...keys);
      if (nested.length) return nested;
    }
  }
  return [];
};
const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : value);
const defined = (record: Rec): Rec =>
  Object.fromEntries(Object.entries(record).filter(([, item]) => item !== undefined));

/** Junctions instrumented in the simulation (both backends use these ids). */
export const JUNCTIONS = ['J01', 'J02', 'J03'] as const;

function portalFine(value: unknown): Rec {
  const fine = rec(value);
  return defined({
    id: fine.id,
    reference: fine.reference,
    plate_number: fine.number_plate ?? fine.plate_number,
    violation_type: fine.violation_type,
    amount: fine.fine_amount ?? fine.amount,
    status: lower(fine.status),
    issued_at: fine.detected_at ?? fine.issued_at,
    paid_at: fine.paid_at,
    location: fine.location ?? fine.junction_id,
    ...Object.fromEntries(
      Object.entries(fine).filter(([key]) => !['number_plate', 'fine_amount', 'detected_at', 'status'].includes(key)),
    ),
  });
}

function portalIncident(value: unknown): Rec {
  const incident = rec(value);
  const plates = arr(incident.involved_plates_display).filter(Boolean);
  const resolved = incident.resolved === true || lower(incident.status) === 'resolved';
  return defined({
    id: incident.id,
    reference: incident.reference,
    status: resolved ? 'resolved' : 'unresolved',
    junction_id: incident.crash_junction ?? incident.junction_id,
    location: incident.location,
    occurred_at: incident.created_at ?? incident.occurred_at,
    crash_type: incident.crash_type ?? incident.kind,
    involved_vehicles: plates.length ? plates : undefined,
    resolved_at: incident.resolved_at,
    resolved_by: incident.resolved_by_name,
    resolution_note: incident.resolution_note,
    live_feed: incident.live_feed,
  });
}

/** One entry per involved vehicle: crash junction first, then each later RFID sighting. */
export type TrackStep = { junction: string; kind: 'crash' | 'sighting'; at?: string; verdict?: string; reports?: number };
export type VehicleRoute = { plate: string; fled: boolean; epc?: string; owner?: string; steps: TrackStep[] };

function portalRoutes(detail: Rec): VehicleRoute[] {
  const incident = rec(detail.incident);
  const crashJunction = typeof incident.crash_junction === 'string' ? incident.crash_junction : undefined;
  const crashZone = arr(detail.crash_zone_rfid).map(rec);
  const sightings = arr(detail.sightings).map(rec);
  return arr(detail.involved_vehicles).map(rec).map((vehicle) => {
    const epc = typeof vehicle.epc === 'string' ? vehicle.epc : undefined;
    const zone = crashZone.find((item) => epc && item.epc === epc);
    const seen = sightings
      .filter((item) => epc && item.epc === epc)
      .sort((a, b) => Number(a.first_seen_ts ?? 0) - Number(b.first_seen_ts ?? 0));
    const steps: TrackStep[] = [
      ...(crashJunction
        ? [{ junction: crashJunction, kind: 'crash' as const, at: String(incident.created_at ?? ''), reports: Number(zone?.report_count ?? 0) || undefined }]
        : []),
      ...seen.map((item) => ({
        junction: String(item.junction_id ?? '—'),
        kind: 'sighting' as const,
        at: typeof item.seen_at === 'string' ? item.seen_at : undefined,
        verdict: typeof rec(item.vision).status === 'string' ? String(rec(item.vision).status) : undefined,
        reports: typeof item.report_count === 'number' ? item.report_count : undefined,
      })),
    ];
    return {
      plate: String(vehicle.plate_display ?? vehicle.plate_norm ?? 'Unknown plate'),
      fled: vehicle.fled === true,
      epc,
      owner: typeof vehicle.owner_name === 'string' ? vehicle.owner_name : undefined,
      steps,
    };
  });
}

/** Routes for the mainapp shape: involved plates, crash junction, then sightings ordered by time. */
function mainappRoutes(detail: Rec): VehicleRoute[] {
  const crashJunction = typeof detail.junction_id === 'string' ? detail.junction_id : undefined;
  const sightings = arr(detail.sightings).map(rec);
  const tags = arr(detail.crash_zone_rfid_snapshot).map(rec);
  return arr(detail.involved_vehicles).map((plate) => {
    const plateText = String(plate);
    const tag = tags.find((item) => item.plate === plateText);
    const seen = sightings
      .filter((item) => item.plate === plateText || (tag && rec(item.payload).epc === tag.epc))
      .sort((a, b) => String(a.seen_at ?? '').localeCompare(String(b.seen_at ?? '')));
    return {
      plate: plateText,
      fled: seen.length > 0,
      epc: typeof tag?.epc === 'string' ? tag.epc : undefined,
      steps: [
        ...(crashJunction
          ? [{ junction: crashJunction, kind: 'crash' as const, at: String(detail.occurred_at ?? ''), reports: Number(tag?.reports ?? 0) || undefined }]
          : []),
        ...seen.map((item) => ({
          junction: String(item.junction_id ?? '—'),
          kind: 'sighting' as const,
          at: typeof item.seen_at === 'string' ? item.seen_at : undefined,
          verdict: item.plate ? 'VISION_CONFIRMED' : undefined,
        })),
      ],
    };
  });
}

export function routesFor(detail: unknown): VehicleRoute[] {
  const record = rec(detail);
  const routes = record.routes;
  if (Array.isArray(routes)) return routes as VehicleRoute[];
  return mainappRoutes(record);
}

function portalIncidentDetail(value: unknown): Rec {
  const detail = rec(value);
  if (!detail.incident) return detail;
  const base = portalIncident(detail.incident);
  const files = [...arr(detail.crash_frames), ...arr(detail.evidence), ...arr(detail.files)]
    .map(rec)
    .filter((file) => typeof file.url === 'string');
  return {
    ...base,
    involved_vehicles: arr(detail.involved_vehicles)
      .map((item) => rec(item).plate_display ?? rec(item).plate_norm)
      .filter(Boolean),
    crash_zone_rfid_snapshot: arr(detail.crash_zone_rfid).map((item) => {
      const tag = rec(item);
      return defined({
        epc: tag.epc,
        plate: tag.plate_display ?? tag.plate ?? tag.plate_norm,
        junction_id: tag.junction_id ?? base.junction_id,
        peak_rssi: tag.peak_rssi,
        reports: tag.report_count,
      });
    }),
    sightings: arr(detail.sightings).map((item) => {
      const sighting = rec(item);
      return defined({
        junction_id: sighting.junction_id,
        plate: sighting.plate_display ?? sighting.plate,
        epc: sighting.epc,
        seen_at: sighting.seen_at,
        reports: sighting.report_count,
        vision_verification: rec(sighting.vision).status ?? (sighting.closed ? 'not verified' : 'verifying'),
      });
    }),
    evidence: files.map((file, index) => ({ id: String(file.name ?? index), url: file.url, kind: file.kind })),
    routes: portalRoutes(detail),
  };
}

function portalSummary(value: unknown): Rec {
  const summary = rec(value);
  if (!summary.crashes) return summary;
  const crashes = rec(summary.crashes);
  const violations = rec(summary.violations);
  const fines = rec(summary.fines);
  const latest = rec(summary.latest_crash_frame);
  return {
    crashes_detected: crashes.total,
    crashes_today: crashes.today,
    unresolved_crashes: crashes.unresolved,
    resolved_today: crashes.resolved_today,
    traffic_violations_detected: violations.total,
    violations_today: violations.today,
    fines_pending: fines.pending_count,
    fines_pending_amount: fines.pending_amount,
    fines_collected_amount: fines.collected_amount,
    latest_crash_frame: typeof latest.url === 'string' ? latest.url : undefined,
    latest_crash_incident_id: latest.incident_id,
    recent_crashes: arr(summary.recent_incidents).map(portalIncident),
    helmet_violations_by_day: arr(violations.by_day),
  };
}

function portalFinesReport(value: unknown): Rec {
  const report = rec(value);
  if (!report.totals) return report;
  const totals = rec(report.totals);
  const monthly = rec(report.monthly_revenue);
  const finesBlock = report.fines;
  return {
    fines_issued: totals.issued_count,
    issued_amount: totals.issued_amount,
    revenue_collected: totals.collected_amount,
    paid_count: totals.paid_count,
    pending_amount: totals.pending_amount,
    pending_count: totals.pending_count,
    year: monthly.year,
    monthly: arr(monthly.months).map((month) => {
      const item = rec(month);
      return { month: item.month, collected: item.collected, payments: item.payments };
    }),
    annual: arr(report.annual),
    items: firstList(finesBlock, 'fines').map(portalFine),
    total: rec(finesBlock).total ?? firstList(finesBlock, 'fines').length,
  };
}

function portalCitizenFines(value: unknown): Rec {
  const response = rec(value);
  if (!Array.isArray(response.fines)) return response;
  const fines = response.fines.map(portalFine);
  const vehicles = arr(response.vehicles);
  return {
    items: fines,
    total: fines.length,
    vehicles,
    registered_vehicles: vehicles.length,
    fines_issued: fines.length,
    unpaid_fines: response.unpaid_count ?? fines.filter((fine) => fine.status === 'unpaid').length,
    total_unpaid: response.total_unpaid,
  };
}

function portalNotifications(value: unknown): Rec {
  const response = rec(value);
  const list = firstList(value, 'notifications');
  return {
    ...response,
    items: list.map((item) => {
      const note = rec(item);
      const readAt = note.read_at ?? (note.read === true ? note.created_at ?? 'read' : null);
      const { read: _read, ...rest } = note;
      return { ...rest, read_at: readAt };
    }),
  };
}

function portalPayments(value: unknown): Rec {
  return {
    items: firstList(value, 'payments').map((item) => {
      const payment = rec(item);
      return defined({
        ...payment,
        receipt_number: payment.receipt_number ?? payment.reference,
        plate_number: payment.plate_number ?? payment.number_plate,
        number_plate: undefined,
      });
    }),
  };
}

function portalCitizenIncident(value: unknown): Rec {
  const incident = rec(value);
  return defined({
    ...incident,
    status: lower(incident.status),
    occurred_at: incident.occurred_at ?? incident.crash_at,
    junction_id: incident.junction_id ?? incident.location,
    crash_at: undefined,
  });
}

function portalCameras(value: unknown): Rec {
  const status = rec(value);
  const list = firstList(value, 'cameras', 'junctions');
  if (list.length) return status;
  const online = status.connected === true;
  return {
    sender_attached: status.sender_attached,
    items: JUNCTIONS.map((junction) => ({ junction_id: junction, status: online ? 'online' : 'offline' })),
  };
}

/** {enabled, streams:[{junction_id, whep_url}], ice_servers} for both backends. */
export function normalizeStreams(value: unknown): { enabled: boolean; whep: Record<string, string>; iceServers: unknown[] } {
  const response = rec(value);
  const streams = firstList(value, 'streams');
  const whep: Record<string, string> = {};
  for (const item of streams) {
    const stream = rec(item);
    const url = stream.whep_url ?? stream.url;
    if (typeof stream.junction_id === 'string' && typeof url === 'string') whep[stream.junction_id] = url;
  }
  const enabled = (response.enabled === true || response.status === 'configured') && Object.keys(whep).length > 0;
  return { enabled, whep, iceServers: arr(response.ice_servers) };
}

/** Converts a portal response into the mainapp shape the screens expect. */
export function adaptResponse(dialect: Dialect, path: string, value: unknown): unknown {
  if (dialect !== 'portal') return value;
  const route = path.split('?')[0];
  if (route === '/api/citizen/fines') return portalCitizenFines(value);
  if (route === '/api/citizen/payments') return portalPayments(value);
  if (route === '/api/citizen/notifications') return portalNotifications(value);
  if (/^\/api\/citizen\/incidents\/[^/]+$/.test(route)) return portalCitizenIncident(value);
  if (route === '/api/authority/summary') return portalSummary(value);
  if (route === '/api/authority/fines') return portalFinesReport(value);
  if (route === '/api/cameras/status') return portalCameras(value);
  if (route === '/api/incidents/board') {
    const board = rec(value);
    if (Array.isArray(board.active)) {
      const incidents = board.active.map(portalIncident);
      return {
        unresolved: incidents.filter((item) => item.status !== 'resolved'),
        resolved_today: incidents.filter((item) => item.status === 'resolved'),
      };
    }
    return { items: firstList(value, 'incidents').map(portalIncident), total: board.total };
  }
  if (/^\/api\/incidents\/[^/]+$/.test(route)) return portalIncidentDetail(value);
  return value;
}

/** Portal paths for screens whose mainapp endpoint the portal names differently. */
export function portalPath(path: string): string {
  if (path === '/api/incidents' || path.startsWith('/api/incidents?')) {
    return '/api/incidents/board?view=records&status=all&page=1&page_size=50';
  }
  if (path === '/api/incidents/board') return '/api/incidents/board?view=radar';
  return path;
}

/** Registration and profile payloads in the field names each backend expects. */
export function citizenRegistration(dialect: Dialect, values: Record<string, string>) {
  if (dialect === 'mainapp') return values;
  return defined({
    full_name: values.name,
    email: values.email,
    password: values.password,
    phone: values.mobile || undefined,
    vehicle_plate: values.vehicle_registration_number || undefined,
    email_verification_token: values.email_verification_token || undefined,
  });
}

export function authorityRegistration(dialect: Dialect, values: Record<string, string>) {
  if (dialect === 'mainapp') return values;
  return defined({
    full_name: values.name,
    email: values.email,
    password: values.password,
    badge_number: values.badge_number,
    jurisdiction: values.jurisdiction || undefined,
    email_verification_token: values.email_verification_token || undefined,
  });
}

export function profileUpdate(dialect: Dialect, values: { name: string; mobile?: string; email: string }) {
  if (dialect === 'mainapp') return defined({ name: values.name, mobile: values.mobile });
  return { full_name: values.name, email: values.email, phone: values.mobile || null };
}
