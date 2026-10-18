# NETRA Mobile App

Standalone Expo prototype for NETRA's accident-confirmation workflow and role-based views.

## What works in this prototype

- Separate demo sign-ins for User, Admin, and Super Admin.
- User can trigger a demo crash alert, receive a repeated vibration while the confirmation
  prompt is open, and record either "Accident confirmed" or "False alarm."
- Admin can view demo accident locations and response statuses only.
- Super Admin can view incident details and camera-feed placeholders.
- Demo incidents are held in app memory for the current session; signing out does not connect
  to or update any external system.

## Deliberate limitations

This app does **not** connect to a real IMU, location service, vehicle-identification service,
backend, database, CARLA, or camera stream. The crash alert is started manually from the User
screen and does not contact emergency services. Camera placeholders are not live video.

The demo credentials shown on the login screen are hard-coded for local UI testing only. They
are not secure authentication and must not be used in production.

## Run locally

```powershell
cd path\to\AgathsetuAPP
npm install
npm start
```

Press `w` in the Expo terminal to open the web version, scan the QR code with Expo Go to use a
phone, or press `a` with an Android emulator running.

## Create an Android APK for download

An Android SDK and JDK are required to build the APK locally. Install Android Studio with its
Android SDK and a compatible JDK, then open this project and run:

```powershell
npx expo prebuild --platform android
Set-Location .\android
.\gradlew.bat assembleDebug
```

The debug APK will be at
`android\app\build\outputs\apk\debug\app-debug.apk`. Copy it to
`download-site\netra.apk` before deploying the download page. Debug APKs are for testing;
create a properly signed release APK before public production distribution.

The APK has **not** been produced on this workstation yet. The local Android build currently
stops while linking native C++ libraries (`std::__ndk1` undefined symbols), so do not deploy
the download page until a successful build has created the APK.

## Publish the download page on Vercel

1. After a successful build, put the APK at `download-site\netra.apk`.
2. In Vercel, import this project and set the project root directory to `download-site`, or
   deploy that folder with the Vercel CLI:

   ```powershell
   npx vercel --prod .\download-site
   ```

3. The page's download button serves `/netra.apk`.

The download site contains only the static page and APK; it does not host or connect to a NETRA
backend. Do not publish debug APKs as production releases.

## Demo accounts

| Role | Email | Password |
|---|---|---|
| User | `user@netra.demo` | `user123` |
| Admin | `admin@netra.demo` | `admin123` |
| Super Admin | `superadmin@netra.demo` | `super123` |
