# AGHAT SETHU Mobile

Expo / React Native client for the citizen and authority portals described in
`APP_PROMPT_FOR_MEMBER2.md`. It uses the documented FastAPI routes and does not generate
dashboard statistics or example incident records locally.

## Configure and run

Install Node.js and Python 3.12 or newer. Start the backend in one PowerShell window:

```powershell
py -3.12 -m venv backend\.venv
& backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
$env:APP_ENV = "development"
$env:JWT_SECRET_KEY = -join (1..48 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$env:BOOTSTRAP_ADMIN_EMAIL = "admin@example.test"
$env:BOOTSTRAP_ADMIN_PASSWORD = Read-Host "Choose a unique admin password (12+ characters)"
$env:CARLA_SHARED_SECRET = -join (1..36 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$env:VISION_SHARED_SECRET = -join (1..36 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
& backend\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload
```

The API starts at `http://localhost:8000`; interactive API documentation is at
`http://localhost:8000/docs`. For the mobile app, install dependencies and set
`EXPO_PUBLIC_API_URL` in the root `.env` to the reachable API origin (without a trailing
`/api`), or enter that origin in the app's server field, then start Expo:

```powershell
npm ci
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
  radar/records/detail, password-confirmed incident resolution, officer approvals, vehicle
  registry/profile/tracking, violation detail, and routine-video upload/job polling.
- Citizen crash-involvement WebSocket alerts open a continuous-vibration confirmation prompt.
  Yes/no responses are submitted to the backend and are shown in the incident report.
- Protected evidence snapshots and citizen clips use bearer-authenticated requests.
- On native builds, the authority live-camera WebSocket sends its bearer token in the
  handshake. Received JPEG frames and crash alerts are shown when the server sends them.
- The prior repeated-vibration accident-confirmation interaction remains as a clearly labelled
  local test only. It does not claim to read an IMU, report a citizen response, or contact
  emergency services.

## Backend and integration boundaries

This repository includes a FastAPI backend, SQLAlchemy data models, API tests, and Docker
Compose configuration. It is a new implementation of the supplied contract; it is not a
connection to a separately hosted member backend. The local development setup uses SQLite.
For a containerized deployment, copy `backend\.env.example` to the repository-root `.env`,
replace every placeholder with unique secrets, set `CORS_ORIGINS` to the deployed web origin,
then run
`docker compose up --build`. Compose runs PostgreSQL and the API; it does not deploy the
Expo client or publish an APK.

The backend provides the citizen and authority routes used by this client, account approval,
vehicle registration/search, fine/payment/notification records, crash incident and RFID
tracking, protected evidence access, video-job status, and authenticated WebSocket ingestion
and delivery. CARLA ingestion requires `CARLA_SHARED_SECRET`; the separate internal vision
ingestion requires `VISION_SHARED_SECRET`. Bootstrap an admin only by explicitly configuring
`BOOTSTRAP_ADMIN_EMAIL` and a unique `BOOTSTRAP_ADMIN_PASSWORD` (at least 12 characters).
There are no built-in demo credentials.

The app/backend do not themselves implement the CARLA simulator, phone/vehicle IMU hardware,
YOLO/ANPR inference, an external payment gateway, a MediaMTX server, or a WebRTC/WHEP player.
Video uploads return an explicit failed job when an analysis worker is not configured; the
backend does not fabricate results. The live-camera client displays authenticated JPEG frames
when available. Browser WebSockets cannot attach bearer headers, so authenticated live sockets
are enabled only on native platforms. Local notifications require the app to be active; remote
push and background delivery are not configured.

An Android release build and download-site deployment are still separate release steps. Do not
advertise an APK download until a signed Android artifact has been built, tested, and published.

## Backend routes used

`/api/auth/{login,me,logout,register/citizen,register/authority}`, `/api/citizen/{vehicles,fines,payments,notifications,incidents}`, `/api/admin/authority-accounts`, `/api/authority/{summary,vehicles,fines,junctions,pending-verifications}`, `/api/routine-violations/{detect,jobs}`, `/api/incidents`, `/api/cameras/status`, `/ws/citizen/alerts`, `/ws/live-cameras`, and `/ws/carla/cameras`.
