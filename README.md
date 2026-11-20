# AGHAT SETHU Mobile

Expo / React Native client (Android, iOS, web) and FastAPI backend for AGHAT SETHU:
crash alerts with a crash-partner assistant, e-challans, vehicle registry, multi-junction
RFID tracking and live junction cameras. The CARLA simulation, vision pipeline and RFID
services are separate projects that send events to this backend.

```
App.tsx              all screens (citizen, authority, admin, super admin)
src/api.ts           API client (auth, errors, timeouts, session expiry)
src/alarm.tsx        crash alarm: looping siren, vibration, keep-awake, full-screen popup
src/notify.ts        Android notification channels and the sticky alarm notification
src/settings.tsx     theme (light/dark) palettes and persisted user settings
src/google.ts        Google sign-in (ID token for /api/auth/google)
src/location.ts      live-location sharing during a crash, officer position
src/IncidentMap.tsx  authority accident map (Google Maps, route, live positions)
assets/sounds/       crash_alarm.wav (generated siren)
backend/             FastAPI service (main.py, models.py, schemas.py, google_auth.py, tests/)
eas.json             EAS build profiles (preview APK, production AAB)
```

## 1. Run locally (development)

### Backend

```powershell
cd MAINAPP
py -3.12 -m venv backend\.venv
backend\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
Copy-Item backend\.env.example backend\.env      # then set real secrets in backend\.env
```

`backend/main.py` does not read `.env` by itself; export the variables in your shell (or use
Docker Compose, which reads `.env`). With no `DATABASE_URL`, data goes to SQLite in
`backend/data`. Start it from the `MAINAPP` folder:

```powershell
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Admin accounts are never created in the app. Set `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` (8+ characters) before the first start to create the first admin.
Authority accounts register in the app and stay pending until an admin approves them.

### App in Expo Go (testing only)

```powershell
npm ci
$env:EXPO_PUBLIC_API_URL = "http://localhost:8000"
npx expo start --localhost
```

With the phone on USB: `adb reverse tcp:8081 tcp:8081` and `adb reverse tcp:8000 tcp:8000`,
then open `exp://127.0.0.1:8081` in Expo Go (SDK 58). Expo Go is for development only. It
is not the deployed app.

## 2. Checks

```powershell
npx tsc --noEmit                         # type check
npx expo lint                            # lint
npx expo-doctor                          # dependency / config check
python -m pytest backend\tests -q        # backend tests (run from MAINAPP with the venv)
npx expo export --platform android       # production JS bundle (what a release build bundles)
```

## 3. Crash alarm

- Citizen: when a crash involves one of their registered vehicles, the backend pushes it over
  `/ws/citizen/alerts` (polling every 15 s as a fallback; unanswered alerts are also raised
  when the app is reopened). The app shows a full-screen popup that the back button cannot
  dismiss, loops a siren (at the phone's media volume), vibrates continuously, keeps
  the screen on and posts a sticky notification, until the person answers:
  - **Yes, I need help** (one tap), or
  - **I'm safe — false alarm** (must be pressed and held for about a second, so it cannot be
    triggered by accident), or
  - **Call 112** opens the dialer and silences only the siren; the popup stays.
- Authority / super admin: every `crash_alert` raises the same alarm until acknowledged.
- Limits: the alarm runs while the app process is alive (foreground or recently
  backgrounded). Waking a closed app needs remote push notifications, which require a push
  service (FCM) and a development or production build; this is not configured. The phone's
  own vibration and notification settings still apply.

## 4. Google sign-in, accident map, live location, themes

**Live location.** When the crash alarm opens on a citizen's phone, the app sends the phone's GPS
position to `POST /api/citizen/incidents/{id}/location` (every 5 s while moving, every 30 s while
still). It keeps sending for an hour after "Yes, I need help", stops on "I'm safe", and the server
refuses positions once the incident is resolved. Citizens can turn this off in Settings. It works
while the app is open (the alarm keeps it on screen); it does not track in the background.

**Accident map (authority, admin, super admin).** The *Accident Map* section and the crash alarm's
"Acknowledge and open map" button show every open crash on Google Maps. For the selected crash the
map shows the crash point, the live phone position of the people involved, the officer's own
position, the road route with distance and drive time, and buttons for turn-by-turn navigation and
calling the person. The crash point comes from `latitude`/`longitude` in the crash event if sent,
otherwise from the junction's position (`JUNCTION_COORDINATES`; the built-in J01–J03 points are
placeholders in Bengaluru).

**Settings** (both portals): theme (phone setting / light / dark), profile, vehicles, live-location
sharing, alarm readiness and sign-out.

**One-time Google Cloud setup** (console.cloud.google.com, one project):

| What | Where it goes |
| --- | --- |
| OAuth consent screen (External) | — |
| OAuth client, type **Web application** | `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (app build) and `GOOGLE_CLIENT_IDS` (backend) |
| OAuth client, type **Android**: package `com.aghatsethu.mobile` + SHA-1 of the signing key (`eas credentials`, and the Play app-signing key for Play builds) | nothing to copy; Google matches it |
| API key with **Maps SDK for Android** enabled, restricted to the package + SHA-1 | `GOOGLE_MAPS_ANDROID_API_KEY` (app build) |
| API key with **Routes API** enabled (server key) | `GOOGLE_ROUTES_API_KEY` (backend only) |

Set the app values for EAS builds with `eas env:create` (preview and production), then rebuild. These
are native changes: Expo Go cannot show the Google button or the native map (the map falls back to
an embedded Google Maps page). After changing plugins locally, regenerate the native project with
`npx expo prebuild --clean` before `npx expo run:android`. Without the keys, the app still works:
the Google button is hidden, the map falls back to the embedded page, and routes become a
straight line plus the turn-by-turn button.

## 5. Deploy the backend (production)

Requirements: a Linux host with Docker, a domain name, and HTTPS in front of the API
(release builds of the app only allow HTTPS, apart from localhost).

```bash
cp backend/.env.example .env     # set POSTGRES_PASSWORD, JWT_SECRET_KEY, BOOTSTRAP_ADMIN_*,
                                 # CARLA_SHARED_SECRET, VISION_SHARED_SECRET (all unique)
docker compose up -d --build     # PostgreSQL 16 + API on port 8000
```

Put a reverse proxy (Caddy, Nginx or a platform load balancer) in front of port 8000 with a
TLS certificate. It must forward WebSocket upgrades for `/ws/...`. Keep the API to one
worker: live sockets and socket tickets live in process memory. `.dockerignore` keeps every
`.env`, the local database and virtual environments out of the image.

## 6. Build the Android app

The API address is compiled into the build from `EXPO_PUBLIC_API_URL`; users can still
change it on the sign-in screen.

```powershell
npm install -g eas-cli          # or: npx eas-cli@latest <command>
eas login
eas init                        # links the project to your Expo account (adds projectId)
eas env:create --name EXPO_PUBLIC_API_URL --value https://api.your-domain --environment preview
eas env:create --name EXPO_PUBLIC_API_URL --value https://api.your-domain --environment production
eas build --platform android --profile preview      # installable APK for testers
eas build --platform android --profile production   # AAB for Google Play
```

Increase `expo.android.versionCode` in `app.json` for every Play Store upload. Publishing to
Google Play (`eas submit`) needs a Play Console account. The GitHub workflow in
`.github/workflows/android-apk.yml` builds a debug-signed test APK only.

## 7. Status

- Live camera feed: unchanged and still being worked on separately.
- Not deployed: the backend and the app are prepared for deployment but not deployed.
