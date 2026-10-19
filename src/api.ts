import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type Role = 'citizen' | 'authority' | 'admin';

export type Account = {
  id?: string | number;
  name?: string;
  email: string;
  role: Role;
  mobile?: string;
  status?: string;
  [key: string]: unknown;
};

export type VideoAsset = {
  uri: string;
  name: string;
  mimeType?: string | null;
};

export type WebSocketOptions = {
  headers: Record<string, string>;
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

  constructor(private baseUrl: string) {
    this.setBaseUrl(baseUrl);
  }

  setBaseUrl(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetch(this.url(path), { ...init, headers });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Network request failed.';
      throw new ApiError(`Could not reach the API: ${reason}`);
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
          ? String((body as { detail: unknown }).detail)
          : typeof body === 'string'
            ? body
            : `Request failed with status ${response.status}.`;
      throw new ApiError(detail, response.status);
    }
    return body as T;
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
      return await this.get<Account>('/api/auth/me');
    } catch (error) {
      await this.logout();
      throw error;
    }
  }

  async registerCitizen(payload: Record<string, string>) {
    return this.post<unknown>('/api/auth/register/citizen', payload);
  }

  async registerAuthority(payload: Record<string, string>) {
    return this.post<unknown>('/api/auth/register/authority', payload);
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
      return await this.get<Account>('/api/auth/me');
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

  authenticatedSocket(path: string) {
    this.requireBaseUrl();
    if (!this.token) throw new ApiError('Sign in to connect to live events.');
    const socketUrl = this.url(path).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    const AuthenticatedSocket = WebSocket as unknown as new (
      url: string,
      protocols: string[],
      options: WebSocketOptions,
    ) => WebSocket;
    return new AuthenticatedSocket(socketUrl, [], {
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }
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
  if (account.role === 'citizen' || account.role === 'authority' || account.role === 'admin') {
    return account.role;
  }
  throw new ApiError('The signed-in account has an unsupported role.');
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
