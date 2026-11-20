import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import {
  Dialect,
  adaptResponse,
  authorityRegistration,
  citizenRegistration,
  portalPath,
  profileUpdate,
} from './adapters';

export type Role = 'citizen' | 'authority' | 'admin' | 'super_admin';

export type Account = {
  id?: string | number;
  name?: string;
  full_name?: string;
  email: string;
  role: Role;
  mobile?: string;
  phone?: string | null;
  status?: string;
  [key: string]: unknown;
};

export type VideoAsset = {
  uri: string;
  name: string;
  mimeType?: string | null;
};

const tokenKey = 'aghatsethu.jwt';
let webToken: string | null = null;

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class ApiClient {
  private token: string | null = null;
  /** Called when an authenticated request is rejected with 401 (expired or revoked session). */
  onUnauthorized?: () => void;

  private dialect: Dialect | null = null;
  private dialectProbe: Promise<Dialect> | null = null;
  /** GET paths that answered 404 on this server: their sections are hidden. */
  private missing = new Set<string>();

  constructor(private baseUrl: string) {
    this.setBaseUrl(baseUrl);
  }

  setBaseUrl(baseUrl: string) {
    const next = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
    if (next !== this.baseUrl) {
      this.dialect = null;
      this.dialectProbe = null;
      this.missing.clear();
    }
    this.baseUrl = next;
  }

  /**
   * Which backend this is. The mainapp backend issues websocket tickets (POST answers 401 without a
   * session); the web-portal backend has no such route (404).
   */
  async serverDialect(): Promise<Dialect> {
    if (this.dialect) return this.dialect;
    if (!this.dialectProbe) {
      this.requireBaseUrl();
      const probe = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(this.url('/api/auth/websocket-ticket'), { method: 'POST', signal: controller.signal });
          const dialect: Dialect = response.status === 404 ? 'portal' : 'mainapp';
          this.dialect = dialect;
          return dialect;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Network request failed.';
          throw new ApiError(`Could not reach the server (${reason}). Check the server address and your connection.`);
        } finally {
          clearTimeout(timeout);
        }
      })();
      this.dialectProbe = probe;
      probe.catch(() => { this.dialectProbe = null; });
    }
    return this.dialectProbe;
  }

  get currentDialect() {
    return this.dialect;
  }

  /** True when a GET to this path is known to 404 on the connected server. */
  isMissing(path: string) {
    return this.missing.has(path.split('?')[0]);
  }

  /** Checks which optional GET endpoints exist (401/403/200 = present, 404 = absent). */
  async probe(paths: string[]) {
    await Promise.all(paths.map(async (path) => {
      try {
        await this.request<unknown>(path, {}, true);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && !/[^/]+\/[0-9a-f-]{8,}/i.test(path)) {
          this.missing.add(path.split('?')[0]);
        }
      }
    }));
  }

  getBaseUrl() {
    return this.baseUrl;
  }

  setToken(token: string | null) {
    this.token = token;
  }

  private requireBaseUrl() {
    if (!this.baseUrl) {
      throw new ApiError('Set the FastAPI base URL before connecting.');
    }
  }

  url(path: string) {
    this.requireBaseUrl();
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async request<T>(path: string, init: RequestInit = {}, quiet = false): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    const controller = new AbortController();
    // Uploads can legitimately take long; everything else should fail fast instead of spinning forever.
    const timeout = setTimeout(() => controller.abort(), init.body instanceof FormData ? 300000 : 20000);
    try {
      response = await fetch(this.url(path), { ...init, headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiError('The server took too long to respond. Check the connection and try again.');
      }
      const reason = error instanceof Error ? error.message : 'Network request failed.';
      throw new ApiError(`Could not reach the server (${reason}). Check the server address and your connection.`);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const detail =
        body && typeof body === 'object' && 'detail' in body
          ? formatDetail((body as { detail: unknown }).detail)
          : typeof body === 'string' && body.length < 300
            ? body
            : `Request failed with status ${response.status}.`;
      // /resolve answers 401 for a wrong password re-entry; that is not an expired session.
      const sessionRejected = response.status === 401
        && !quiet
        && !path.startsWith('/api/auth/login')
        && !path.startsWith('/api/auth/logout')
        && !path.endsWith('/resolve');
      if (sessionRejected) {
        this.setToken(null);
        await clearToken().catch(() => undefined);
        this.onUnauthorized?.();
      }
      throw new ApiError(detail, response.status);
    }
    return body as T;
  }

  /** GET, converted to the mainapp response shape when the server is the web-portal backend. */
  async get<T>(path: string): Promise<T> {
    const dialect = await this.serverDialect();
    if (dialect === 'portal' && path === '/api/citizen/vehicles') {
      // The portal lists a citizen's vehicles alongside their fines.
      const fines = await this.request<unknown>('/api/citizen/fines');
      return { items: asRecord(adaptResponse(dialect, '/api/citizen/fines', fines)).vehicles ?? [] } as T;
    }
    const target = dialect === 'portal' ? portalPath(path) : path;
    return adaptResponse(dialect, target, await this.request<unknown>(target)) as T;
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  put<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  async login(email: string, password: string) {
    const result = await this.post<Record<string, unknown>>('/api/auth/login', { email, password });
    const token = result.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new ApiError('Login response did not include an access_token.');
    }
    this.setToken(token);
    await saveToken(token);
    try {
      return normalizeAccount(await this.get<unknown>('/api/auth/me'));
    } catch (error) {
      await this.logout();
      throw error;
    }
  }

  /**
   * Signs in with a Google ID token. On the citizen portal a new Google user gets a citizen account;
   * `needsVehicle` is then true until they add their vehicle (crash alerts are matched by plate).
   */
  async loginWithGoogle(idToken: string, portal: 'citizen' | 'authority' | 'admin') {
    if ((await this.serverDialect()) === 'portal') {
      throw new ApiError('This server does not support Google sign-in. Use your email and password.');
    }
    let result: Record<string, unknown>;
    try {
      result = asRecord(await this.post<unknown>('/api/auth/google', { id_token: idToken, portal }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && portal === 'citizen') {
        throw new ApiError('This server does not support Google sign-in yet. Use your email and password.', 404);
      }
      throw error;
    }
    const token = result.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new ApiError('Google sign-in response did not include an access_token.');
    }
    this.setToken(token);
    await saveToken(token);
    try {
      const account = normalizeAccount(await this.get<unknown>('/api/auth/me'));
      return { account, needsVehicle: result.needs_vehicle === true, created: result.created === true };
    } catch (error) {
      await this.logout();
      throw error;
    }
  }

  /** Adds a vehicle to the signed-in citizen's account. */
  addVehicle(plate: string) {
    return this.post<unknown>('/api/citizen/vehicles', { vehicle_registration_number: plate });
  }

  /** Reports this phone's position for an open crash involving the citizen. */
  shareIncidentLocation(incidentId: string, position: { latitude: number; longitude: number; accuracy_m?: number | null }) {
    return this.request<unknown>(
      `/api/citizen/incidents/${encodeURIComponent(incidentId)}/location`,
      { method: 'POST', body: JSON.stringify(position) },
      true,
    );
  }

  async registerCitizen(payload: Record<string, string>) {
    const dialect = await this.serverDialect();
    return this.post<unknown>('/api/auth/register/citizen', citizenRegistration(dialect, payload));
  }

  async registerAuthority(payload: Record<string, string>) {
    const dialect = await this.serverDialect();
    return this.post<unknown>('/api/auth/register/authority', authorityRegistration(dialect, payload));
  }

  /** Whether this server makes new accounts confirm their email with an emailed code. */
  async emailOtpRequired(): Promise<boolean> {
    try {
      const config = asRecord(await this.request<unknown>('/api/auth/email-otp/config', {}, true));
      return config.required === true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return false; // server without email codes
      throw error;
    }
  }

  async requestEmailOtp(email: string) {
    return asRecord(await this.post<unknown>('/api/auth/email-otp/request', { email }));
  }

  /** Returns the short-lived token that proves the email was verified. */
  async verifyEmailOtp(email: string, code: string): Promise<string> {
    const result = asRecord(await this.post<unknown>('/api/auth/email-otp/verify', { email, code }));
    if (typeof result.verification_token !== 'string') throw new ApiError('The server did not confirm the code.');
    return result.verification_token;
  }

  async updateProfile(values: { name: string; mobile?: string; email: string }) {
    const dialect = await this.serverDialect();
    return normalizeAccount(await this.patch<unknown>('/api/auth/me', profileUpdate(dialect, values)));
  }

  async uploadVideo(asset: VideoAsset) {
    const fileResponse = await fetch(asset.uri);
    if (!fileResponse.ok) throw new ApiError('Could not read the selected video file.');
    const file = await fileResponse.blob();
    const form = new FormData();
    form.append('file', file, asset.name);
    return this.request<Record<string, unknown>>('/api/routine-violations/detect', {
      method: 'POST',
      body: form,
    });
  }

  async saveSession(token: string) {
    this.setToken(token);
    await saveToken(token);
  }

  async restoreSession() {
    const token = await readToken();
    this.setToken(token);
    if (!token) return null;
    try {
      return normalizeAccount(await this.get<unknown>('/api/auth/me'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await this.logout();
        return null;
      }
      throw error;
    }
  }

  async logout() {
    try {
      if (this.token) await this.post<unknown>('/api/auth/logout');
    } finally {
      this.setToken(null);
      await clearToken();
    }
  }

  get currentToken() {
    return this.token;
  }

  /** wss URL of the website backend's event stream. Authenticate with the first message, not the URL. */
  eventsSocketUrl() {
    return this.url('/ws/events').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  }

  async authenticatedSocket(path: string) {
    this.requireBaseUrl();
    if (!this.token) throw new ApiError('Sign in to connect to live events.');
    const separator = path.includes('?') ? '&' : '?';
    let credential: string;
    if ((await this.serverDialect()) === 'portal') {
      // The portal backend authenticates sockets with the session token itself (served over wss).
      credential = `token=${encodeURIComponent(this.token)}`;
    } else {
      const result = await this.post<{ ticket: string }>('/api/auth/websocket-ticket');
      if (typeof result.ticket !== 'string' || result.ticket.length === 0) {
        throw new ApiError('The API did not issue a live-event connection ticket.');
      }
      credential = `ticket=${encodeURIComponent(result.ticket)}`;
    }
    const socketUrl = this.url(`${path}${separator}${credential}`)
      .replace(/^https:/i, 'wss:')
      .replace(/^http:/i, 'ws:');
    return new WebSocket(socketUrl);
  }
}

const fieldLabels: Record<string, string> = {
  name: 'Full name',
  email: 'Email',
  mobile: 'Mobile number',
  password: 'Password',
  vehicle_registration_number: 'Vehicle registration number',
  badge_number: 'Badge / service number',
  jurisdiction: 'Jurisdiction',
};

/** FastAPI validation errors arrive as a list of {loc, msg}; turn them into readable sentences. */
export function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      const record = asRecord(item);
      const loc = Array.isArray(record.loc) ? record.loc : [];
      const key = String(loc[loc.length - 1] ?? '');
      const label = fieldLabels[key] ?? key.replaceAll('_', ' ');
      const message = String(record.msg ?? 'is invalid').replace(/^Value error, /, '');
      return label ? `${label}: ${message}` : message;
    });
    return messages.join('\n') || 'The request was rejected.';
  }
  return 'The request was rejected.';
}

async function saveToken(token: string) {
  if (Platform.OS === 'web') {
    webToken = token;
    return;
  }
  await SecureStore.setItemAsync(tokenKey, token);
}

async function readToken() {
  if (Platform.OS === 'web') return webToken;
  return SecureStore.getItemAsync(tokenKey);
}

async function clearToken() {
  if (Platform.OS === 'web') {
    webToken = null;
    return;
  }
  await SecureStore.deleteItemAsync(tokenKey);
}

export function roleFromAccount(account: Account): Role {
  if (
    account.role === 'citizen' ||
    account.role === 'authority' ||
    account.role === 'admin' ||
    account.role === 'super_admin'
  ) {
    return account.role;
  }
  throw new ApiError('The signed-in account has an unsupported role.');
}

export function normalizeAccount(value: unknown): Account {
  const account = asRecord(value);
  const role = account.role;
  if (
    typeof account.email !== 'string' ||
    (role !== 'citizen' && role !== 'authority' && role !== 'admin' && role !== 'super_admin')
  ) {
    throw new ApiError('The backend returned an invalid account profile.');
  }
  const name = typeof account.full_name === 'string'
    ? account.full_name
    : typeof account.name === 'string'
      ? account.name
      : undefined;
  const mobile = typeof account.phone === 'string'
    ? account.phone
    : typeof account.mobile === 'string'
      ? account.mobile
      : undefined;
  return { ...account, email: account.email, role, name, mobile } as Account;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asList(value: unknown, keys: string[] = []): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  for (const key of ['items', 'results', 'data', ...keys]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate !== null && typeof candidate === 'object') {
      const nested = asList(candidate, keys);
      if (nested.length > 0) return nested;
    }
  }
  if (Object.keys(record).length > 0) return [value];
  return [];
}

export function textValue(value: unknown) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function displayDate(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return textValue(value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(parsed);
}

export function displayMoney(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return textValue(value);
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(number);
}
