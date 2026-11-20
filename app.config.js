/**
 * Adds the Google keys from the environment to app.json, so no key is committed to the repository.
 *
 *   GOOGLE_MAPS_ANDROID_API_KEY  Maps SDK for Android key (in-app accident map). Without it the map
 *                                screens fall back to opening Google Maps.
 *   GOOGLE_IOS_URL_SCHEME        Reversed iOS OAuth client ID (com.googleusercontent.apps....), iOS only.
 *   EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID  Web OAuth client ID the app asks Google for an ID token with
 *                                (read by the app at runtime, see src/google.ts).
 *
 * For EAS builds set them with `eas env:create` (or in eas.json `env`).
 */
module.exports = ({ config }) => {
  const plugins = [...(config.plugins ?? [])];
  const iosUrlScheme = (process.env.GOOGLE_IOS_URL_SCHEME ?? '').trim();
  if (iosUrlScheme) {
    // The plugin only configures iOS and refuses to run without the scheme; Android needs no plugin.
    plugins.push(['@react-native-google-signin/google-signin', { iosUrlScheme }]);
  }
  const mapsKey = (process.env.GOOGLE_MAPS_ANDROID_API_KEY ?? '').trim();
  return {
    ...config,
    plugins,
    android: {
      ...config.android,
      config: {
        ...(config.android?.config ?? {}),
        ...(mapsKey ? { googleMaps: { apiKey: mapsKey } } : {}),
      },
    },
    extra: {
      ...(config.extra ?? {}),
      googleMapsConfigured: Boolean(mapsKey),
    },
  };
};
