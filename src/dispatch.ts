import { asRecord } from './api';
import { formatDistance } from './location';

/** What a citizen answered on the crash alarm. */
export type CrashOutcome = 'need_help' | 'minor_ok' | 'false_alarm';

export function outcomeLabel(value: unknown): string {
  if (value === 'need_help') return 'Needs help';
  if (value === 'minor_ok') return 'Minor accident — no help needed';
  if (value === 'false_alarm') return 'False alarm — no accident';
  return 'No answer yet';
}

export type DispatchInfo = {
  /** broadcast: no centres configured, every officer alerted · dispatched: nearest centres · all_officers: escalated */
  mode: 'broadcast' | 'dispatched' | 'all_officers';
  status: 'open' | 'awaiting' | 'accepted' | 'closed';
  acceptedCenter: { name: string; phone: string | null; distance: number | null } | null;
  acceptedBy: string | null;
  offers: { centerId: string; name: string; distance: number; status: string }[];
  offeredCenterIds: string[];
  myStatus: string | null;
};

export function dispatchInfo(value: unknown): DispatchInfo {
  const record = asRecord(value);
  const accepted = asRecord(record.accepted_center);
  const mode = record.mode === 'dispatched' || record.mode === 'all_officers' ? record.mode : 'broadcast';
  const status = ['awaiting', 'accepted', 'closed'].includes(String(record.status)) ? record.status as DispatchInfo['status'] : 'open';
  return {
    mode,
    status,
    acceptedCenter: typeof accepted.name === 'string'
      ? { name: accepted.name, phone: typeof accepted.phone === 'string' ? accepted.phone : null, distance: typeof accepted.distance_m === 'number' ? accepted.distance_m : null }
      : null,
    acceptedBy: typeof record.accepted_by === 'string' ? record.accepted_by : null,
    offers: (Array.isArray(record.offers) ? record.offers : []).map((item) => {
      const offer = asRecord(item);
      return { centerId: String(offer.center_id ?? ''), name: String(offer.center_name ?? '—'), distance: Number(offer.distance_m) || 0, status: String(offer.status ?? '') };
    }),
    offeredCenterIds: (Array.isArray(record.offered_center_ids) ? record.offered_center_ids : []).map(String),
    myStatus: typeof record.my_center_status === 'string' ? record.my_center_status : null,
  };
}

/** Whether an officer of `myCenterId` can accept this crash now. */
export function canAccept(dispatch: DispatchInfo, myCenterId: string, isOfficer: boolean) {
  if (!isOfficer || !myCenterId || dispatch.status === 'accepted' || dispatch.status === 'closed') return false;
  if (dispatch.mode === 'all_officers') return true;
  if (dispatch.mode !== 'dispatched') return false;
  if (dispatch.myStatus) return dispatch.myStatus === 'offered' || dispatch.myStatus === 'declined';
  return dispatch.offeredCenterIds.includes(myCenterId);
}

/** One line for lists and the alarm: who has the crash. */
export function dispatchLine(dispatch: DispatchInfo, myCenterId = ''): string {
  if (dispatch.mode === 'broadcast') return 'Sent to all officers (no authority centres set up).';
  if (dispatch.status === 'accepted' && dispatch.acceptedCenter) {
    const mine = dispatch.offers.some((offer) => offer.status === 'accepted' && offer.centerId === myCenterId);
    return `${mine ? 'Your centre' : dispatch.acceptedCenter.name} accepted${dispatch.acceptedBy ? ` (${dispatch.acceptedBy})` : ''}.`;
  }
  if (dispatch.status === 'closed') return 'Resolved.';
  const waiting = dispatch.offers.filter((offer) => offer.status === 'offered');
  const prefix = dispatch.mode === 'all_officers' ? 'No nearby centre accepted — open to every officer. ' : '';
  return `${prefix}Waiting for acceptance: ${waiting.map((offer) => `${offer.name} (${formatDistance(offer.distance)})`).join(', ') || 'no centre has answered'}.`;
}
