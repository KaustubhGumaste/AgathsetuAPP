import { Platform } from 'react-native';

/**
 * Google Sign-In on the phone. Google returns an ID token, which the backend verifies
 * (POST /api/auth/google) before issuing the app's own session.
 *
 * Needs EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID (the *Web* OAuth client ID; the backend's GOOGLE_CLIENT_IDS
 * must contain the same value) and an Android OAuth client registered with this app's package name
 * and signing SHA-1. Not available in Expo Go or on web: the native module is loaded lazily so the
 * rest of the app still runs there.
 */

const webClientId = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim();

type GoogleModule = typeof import('@react-native-google-signin/google-signin');

let module: GoogleModule | null | undefined;
let configured = false;

function load(): GoogleModule | null {
  if (module !== undefined) return module;
  if (Platform.OS === 'web' || !webClientId) {
    module = null;
    return module;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    module = require('@react-native-google-signin/google-signin') as GoogleModule;
  } catch {
    module = null; // Expo Go: native module not bundled
  }
  return module;
}

/** Whether the Google button can be offered in this build. */
export function googleSignInAvailable() {
  return load() !== null;
}

export class GoogleSignInCancelled extends Error {
  constructor() {
    super('Google sign-in was cancelled.');
    this.name = 'GoogleSignInCancelled';
  }
}

/** Shows Google's account chooser and returns the ID token. Throws GoogleSignInCancelled if dismissed. */
export async function getGoogleIdToken(): Promise<string> {
  const google = load();
  if (!google) throw new Error('Google sign-in is not available in this version of the app.');
  const { GoogleSignin, isCancelledResponse, isErrorWithCode, statusCodes } = google;
  if (!configured) {
    GoogleSignin.configure({ webClientId, offlineAccess: false });
    configured = true;
  }
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    // Always show the account chooser, so a person can pick a different Google account each time.
    await GoogleSignin.signOut().catch(() => null);
    const response = await GoogleSignin.signIn();
    if (isCancelledResponse(response)) throw new GoogleSignInCancelled();
    const token = response.data.idToken;
    if (!token) throw new Error('Google did not return an ID token. Check the web client ID configuration.');
    return token;
  } catch (error) {
    if (error instanceof GoogleSignInCancelled) throw error;
    if (isErrorWithCode(error)) {
      if (error.code === statusCodes.SIGN_IN_CANCELLED) throw new GoogleSignInCancelled();
      if (error.code === statusCodes.IN_PROGRESS) throw new Error('Google sign-in is already open.');
      if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        throw new Error('Google Play services is missing or out of date on this phone.');
      }
      // DEVELOPER_ERROR (code 10): the Android OAuth client / SHA-1 does not match this build.
      if (String(error.code) === '10' || error.code === 'DEVELOPER_ERROR') {
        throw new Error('Google sign-in is not set up for this build of the app (OAuth client / SHA-1 mismatch).');
      }
    }
    throw error instanceof Error ? error : new Error('Google sign-in failed.');
  }
}

export async function googleSignOut() {
  const google = load();
  if (!google || !configured) return;
  await google.GoogleSignin.signOut().catch(() => null);
}
