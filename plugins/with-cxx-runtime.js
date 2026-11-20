/**
 * Links the C++ runtime into every native library of the app (codegen libraries such as
 * react-native-safe-area-context). With NDK 27 on Windows they otherwise fail to link with
 * "undefined symbol: operator new / __cxa_throw ...". Harmless where the runtime is already linked.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '-DCMAKE_CXX_STANDARD_LIBRARIES=-lc++_shared -latomic -lm';

module.exports = function withCxxRuntime(config) {
  return withAppBuildGradle(config, (gradle) => {
    if (gradle.modResults.contents.includes(MARKER)) return gradle;
    gradle.modResults.contents = gradle.modResults.contents.replace(
      /defaultConfig \{\n/,
      `defaultConfig {\n        externalNativeBuild { cmake { arguments "${MARKER}" } }\n`,
    );
    if (!gradle.modResults.contents.includes(MARKER)) {
      throw new Error('with-cxx-runtime: could not find defaultConfig in android/app/build.gradle');
    }
    return gradle;
  });
};
