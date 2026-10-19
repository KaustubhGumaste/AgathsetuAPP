# AGHAT SETHU Mobile

Expo / React Native client for the citizen and authority portals described in
`APP_PROMPT_FOR_MEMBER2.md`. It uses the documented FastAPI routes and does not generate
dashboard statistics or example incident records locally.

## Configure and run

Install Node.js, then run from the project folder:

```powershell
npm ci
Copy-Item .env.example .env
```

Set `EXPO_PUBLIC_API_URL` in `.env` to the reachable FastAPI origin (for example,
`https://api.example.com`, without a trailing `/api`). Alternatively, enter the origin on the
app's portal-selection screen; that value lasts for the current app session. Start Expo:

```powershell
npm start
```

Use `w` for the web client or scan the QR code with Expo Go. A physical phone or emulator
cannot use its own `localhost` to reach a backend on the development computer; use a LAN
address or deployed HTTPS URL. An HTTPS site URL on port `5173` is typically Vite, not FastAPI:
only use it if it actually proxies the documented `/api` routes and `/ws/live-cameras`.

## Included

- Citizen and authority registration/login, role routing from `/api/auth/me`, profile editing,
  and server-side sign-out.
- Native JWT persistence through Expo SecureStore. Web sessions are memory-only and end when
  the page reloads; the app does not store bearer tokens in browser local storage.
- Citizen fines, payment submission (`upi`, `card`, or `netbanking`), payment history,
  notifications, profile, and incident report views.
- Authority summary, camera status, junctions, fines/revenue, pending verification, incident
  radar/records/detail, password-confirmed incident resolution, and routine-video upload/job
  polling.
- Protected evidence snapshots and citizen clips use bearer-authenticated requests.
- On native builds, the authority live-camera WebSocket sends its bearer token in the
  handshake. Received JPEG frames and crash alerts are shown when the server sends them.
- The prior repeated-vibration accident-confirmation interaction remains as a clearly labelled
  local test only. It does not claim to read an IMU, report a citizen response, or contact
  emergency services.

## Backend contract gaps and runtime notes

The supplied prompt is an endpoint summary, not the FastAPI source or OpenAPI schema. The
backend was not available during implementation, so request/response field names and real
server behavior have not been verified. The separate `Downloads\app` project is a Flask
disaster-image classifier, not this traffic platform. Connect to the actual backend and check
its `/docs` before production use.

The supplied contract does not document citizen vehicle-list/search routes or authority
vehicle-registry/search/tracking routes; those pages report that no endpoint is available
instead of showing invented vehicles. It also does not document a separate Super Admin role
or extra Super Admin endpoints. The app accepts only the backend roles `citizen`, `authority`,
and `admin`; authority/admin share the documented authority portal, and backend authorization
remains authoritative.

Live H.264 WebRTC/WHEP playback is not implemented: the prompt describes signaling but does
not specify the native WebRTC transport integration. Camera tiles display authenticated
WebSocket JPEG frames when supplied and otherwise show an explicit no-frame state. The
browser's WebSocket API cannot attach bearer headers, so the authenticated live-camera socket
is enabled only on native platforms.

Local notifications are presented for live crash events while the authority app is open.
Background or remote push delivery is not configured because the backend contract does not
describe device-token registration or push delivery.

The Android package has not been rebuilt or deployed. The previous local Android build stopped
during C++ native-library linking; this app's native dependencies require a fresh validated
development/release build before APK distribution. The static `download-site` page is not
deployed and must not be advertised as a working APK download until a signed APK is available.

## Backend routes used

`/api/auth/{login,me,logout,register/citizen,register/authority}`, `/api/citizen/{fines,payments,notifications,incidents}`, `/api/authority/{summary,fines,junctions,pending-verifications}`, `/api/routine-violations/{detect,jobs}`, `/api/incidents`, `/api/cameras/status`, and `/ws/live-cameras`.
