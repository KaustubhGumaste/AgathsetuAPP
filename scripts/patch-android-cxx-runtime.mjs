import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function patchOnce(filePath, originalPattern, patchedPattern, replacement) {
  const source = fs.readFileSync(filePath, "utf8");
  if (patchedPattern.test(source)) {
    return;
  }

  const globalPattern = new RegExp(originalPattern.source, `${originalPattern.flags}g`);
  const matches = source.match(globalPattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Expected one Android C++ runtime patch point in ${filePath}, found ${matches.length}`);
  }

  fs.writeFileSync(filePath, source.replace(originalPattern, replacement));
}

patchOnce(
  path.join(root, "node_modules", "expo-modules-core", "android", "build.gradle"),
  /^[ \t]*"-DANDROID_STL=c\+\+_shared",[ \t]*$/m,
  /^[ \t]*"-DCMAKE_CXX_STANDARD_LIBRARIES=-lc\+\+_shared -latomic -lm",[ \t]*$/m,
  '$&\n          "-DCMAKE_CXX_STANDARD_LIBRARIES=-lc++_shared -latomic -lm",',
);

patchOnce(
  path.join(root, "node_modules", "react-native", "ReactAndroid", "cmake-utils", "ReactNative-application.cmake"),
  /^[ \t]*reactnative[ \t]+# prefab ready[ \t]*$/m,
  /^[ \t]*reactnative[ \t]+# prefab ready[ \t]*\r?\n[ \t]*c\+\+_shared[ \t]*$/m,
  "$&\n        c++_shared",
);
