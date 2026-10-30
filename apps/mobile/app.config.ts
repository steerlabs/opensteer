import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ExpoConfig } from "expo/config";
import { z } from "zod";

/**
 * This file is the whole native project: `ios/` and `android/` are generated
 * from it by `expo prebuild` and are not tracked. Anything a native build needs
 * belongs here rather than in a checked-in Xcode or Gradle edit.
 *
 * Node's filesystem is build-time only; nothing here reaches the bundle. Expo
 * loads this file through Node, which cannot follow the workspace's NodeNext
 * `./x.js` specifiers, so the application id is spelled out rather than
 * imported from `@opensteer/core`. `tests/mobile-application-id.test.ts` pins
 * the two to each other, and to the OAuth callbacks whose private-use scheme it
 * must be.
 */
const applicationId = "com.opensteer.mobile";

// Expo evaluates this configuration before native project generation. Both pods
// compile the same catalog-derived contracts; generation cannot be optional.
execFileSync("pnpm", ["exec", "tsx", "../../scripts/generate-apple-data-contracts.ts"], {
  cwd: new URL(".", import.meta.url),
  stdio: "inherit",
});

const release = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { readonly version: string };

/**
 * Where the Firebase configuration for this Android build is, supplied by the
 * build command.
 *
 * Expo's push token on Android is an FCM token, and FCM needs the sender the
 * `google-services.json` names. The file identifies one Firebase project and
 * is a build input, never a checked-in one: a repository that carried it would
 * bind every build anyone makes to one project's sender. A build made without
 * it is a real, honest build — it simply cannot be sent to, and the app's
 * Notifications settings says exactly that instead of asking the operating
 * system for a token that cannot exist.
 *
 * Absent and unusable are different answers, so both are decided here rather
 * than by a native build failing hours later: a variable that is set must name
 * a file that exists, and anything else stops the configuration with the reason.
 */
const GoogleServicesFileSchema = z
  .string()
  .trim()
  .min(1, "it is empty")
  .max(4_096, "it is too long to be a path")
  .refine((path) => existsSync(path), { error: "no file exists at that path" });

const googleServicesFile = readGoogleServicesFile();
const androidPushConfigured = googleServicesFile !== undefined;

function readGoogleServicesFile(): string | undefined {
  const supplied = process.env.OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE;
  if (supplied === undefined) return undefined;
  const parsed = GoogleServicesFileSchema.safeParse(supplied);
  if (parsed.success) return parsed.data;
  throw new Error(
    `OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE must name this Android build's google-services.json: ${
      parsed.error.issues[0]?.message ?? "it is not a usable path"
    }.`,
  );
}

const config: ExpoConfig = {
  name: "Opensteer",
  slug: "opensteer",
  platforms: ["ios", "android"],
  version: release.version,
  // The private-use scheme the two OAuth callbacks are registered under. The
  // operating system hands it to exactly one installed build, which is the
  // whole of a native client's redirect security.
  scheme: applicationId,
  orientation: "default",
  icon: "./assets/icon.png",
  // Dark only. There is no light palette to switch to, so offering the choice
  // would be a setting that does nothing.
  userInterfaceStyle: "dark",
  backgroundColor: "#080808",
  // There is no `newArchEnabled` here because SDK 58 has no other architecture:
  // React Native 0.86 dropped the legacy renderer, so the flag was removed from
  // the config type along with it.
  assetBundlePatterns: ["**/*"],
  ios: {
    bundleIdentifier: applicationId,
    supportsTablet: true,
    // Resizing shares one navigation history and draft owner across device poses.
    infoPlist: {
      NSMicrophoneUsageDescription:
        "Opensteer uses the microphone while you dictate a message or talk to Opensteer.",
      NSCalendarsFullAccessUsageDescription:
        "Agents you allow can read your calendar, and change it if you let them, while Opensteer is open.",
      NSRemindersFullAccessUsageDescription:
        "Agents you allow can read your reminders, and change them if you let them, while Opensteer is open.",
      NSContactsUsageDescription:
        "Agents you allow can find people in your contacts while Opensteer is open.",
      NSLocationWhenInUseUsageDescription:
        "Agents you allow can read your current location while Opensteer is open.",
      NSPhotoLibraryUsageDescription:
        "Agents you allow can read photo and album details while Opensteer is open. They cannot view, change or delete your photos.",
      PHPhotoLibraryPreventAutomaticLimitedAccessAlert: true,
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: "Default Configuration",
              UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
            },
          ],
        },
      },
    },
  },
  // Read at runtime through `expo-constants`. `googleServicesFile` itself is a
  // prebuild input and does not survive into the manifest, so whether this
  // build has Android push credentials has to be stated as a fact of its own.
  extra: { androidPushConfigured },
  android: {
    package: applicationId,
    // WebRTC's plugin requests video/overlay/Bluetooth permissions indiscriminately.
    // Audio uses OS media routing and never discovers or selects Bluetooth devices.
    blockedPermissions: [
      "android.permission.CAMERA",
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_ADMIN",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.SYSTEM_ALERT_WINDOW",
    ],
    ...(androidPushConfigured ? { googleServicesFile } : {}),
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#080808",
      // There is no `newArchEnabled` here because SDK 58 has no other architecture:
      // React Native 0.86 dropped the legacy renderer, so the flag was removed from
      // the config type along with it.
    },
  },
  plugins: [
    // Plist mods compose in reverse order: remove the upstream camera key last.
    "./plugins/with-voice.cjs",
    "expo-secure-store",
    "@config-plugins/react-native-webrtc",
    "./plugins/with-apple-data.cjs",
    "./plugins/with-dictation.cjs",
    "expo-web-browser",
    [
      "expo-image-picker",
      {
        cameraPermission: false,
        photosPermission: "Allow Opensteer to attach photos you choose to a conversation.",
      },
    ],
    [
      "expo-notifications",
      {
        // Android draws the silhouette of this file's alpha channel and paints
        // it in `color`; the mark is generated flat white by
        // `scripts/generate-app-icons.mjs` for exactly that reason. iOS uses
        // the application icon and takes neither.
        color: "#e6beb0",
        icon: "./assets/notification-icon.png",
      },
    ],
    [
      "expo-splash-screen",
      {
        backgroundColor: "#080808",
        // There is no `newArchEnabled` here because SDK 58 has no other architecture:
        // React Native 0.86 dropped the legacy renderer, so the flag was removed from
        // the config type along with it.
        image: "./assets/splash-icon.png",
        imageWidth: 160,
      },
    ],
  ],
};

export default config;
