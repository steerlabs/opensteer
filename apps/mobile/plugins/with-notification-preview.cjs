const {
  withEntitlementsPlist,
  withXcodeProject,
  withDangerousMod,
  withAndroidManifest,
} = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");
const group = "group.com.opensteer.mobile.notifications";
const targetName = "OpensteerNotificationService";
const service = "com.opensteer.notificationpreview.OpensteerFirebaseMessagingService";
function manifest(mod) {
  mod.manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
  const app = mod.manifest.application[0];
  const removed = [
    "expo.modules.notifications.service.ExpoFirebaseMessagingService",
    "com.google.firebase.messaging.FirebaseMessagingService",
  ];
  app.service = (app.service || []).filter(
    (s) => ![service, ...removed].includes(s.$["android:name"]),
  );
  app.service.push(
    ...removed.map((name) => ({ $: { "android:name": name, "tools:node": "remove" } })),
    {
      $: { "android:name": service, "android:exported": "false" },
      "intent-filter": [
        { action: [{ $: { "android:name": "com.google.firebase.MESSAGING_EVENT" } }] },
      ],
    },
  );
  return mod;
}
function project(project, config) {
  if (
    Object.values(project.pbxNativeTargetSection()).some(
      (target) => target.name?.replaceAll('"', "") === targetName,
    )
  )
    return project;
  const target = project.addTarget(
    targetName,
    "app_extension",
    targetName,
    "com.opensteer.mobile.NotificationService",
  );
  const sources = ["NotificationService.swift", "Preview.swift", "KeyStore.swift"].map(
    (f) => `${targetName}/${f}`,
  );
  project.addBuildPhase(sources, "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  for (const name of ["CryptoKit", "Security", "UserNotifications"]) {
    project.addFramework(`${name}.framework`, { target: target.uuid, link: true });
  }
  // xcode's addTarget creates the container dependency and Embed App Extensions phase.
  const configs = project.pbxXCBuildConfigurationSection();
  const parent =
    Object.values(configs).find(
      (c) =>
        c.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER?.replaceAll('"', "") === "com.opensteer.mobile",
    )?.buildSettings || {};
  const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
  for (const ref of list.buildConfigurations) {
    const settings = configs[ref.value].buildSettings;
    Object.assign(settings, {
      PRODUCT_BUNDLE_IDENTIFIER: '"com.opensteer.mobile.NotificationService"',
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      SWIFT_VERSION: "5.9",
      INFOPLIST_FILE: `${targetName}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${targetName}/${targetName}.entitlements`,
      APPLICATION_EXTENSION_API_ONLY: "YES",
      SKIP_INSTALL: "YES",
      // Expo writes the app's version into its Info.plist from config, leaving the
      // template's MARKETING_VERSION behind; an extension must match the app.
      MARKETING_VERSION: config.version ?? "1.0",
      CURRENT_PROJECT_VERSION: config.ios?.buildNumber ?? "1",
      IPHONEOS_DEPLOYMENT_TARGET: parent.IPHONEOS_DEPLOYMENT_TARGET || "16.4",
      ...(parent.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: parent.DEVELOPMENT_TEAM } : {}),
      TARGETED_DEVICE_FAMILY: '"1,2"',
    });
  }
  return project;
}
module.exports = function withNotificationPreview(config) {
  config = withEntitlementsPlist(config, (next) => {
    next.modResults["com.apple.security.application-groups"] = [
      ...new Set([...(next.modResults["com.apple.security.application-groups"] || []), group]),
    ];
    return next;
  });
  config = withDangerousMod(config, [
    "ios",
    async (next) => {
      const dir = path.join(next.modRequest.platformProjectRoot, targetName);
      fs.mkdirSync(dir, { recursive: true });
      const src = path.join(next.modRequest.projectRoot, "modules/notification-preview/ios");
      fs.copyFileSync(
        path.join(src, "Extension/NotificationService.swift"),
        path.join(dir, "NotificationService.swift"),
      );
      for (const file of ["Preview.swift", "KeyStore.swift"])
        fs.copyFileSync(path.join(src, "Sources/NotificationPreview", file), path.join(dir, file));
      const plist = require("@expo/plist").default;
      fs.writeFileSync(
        path.join(dir, "Info.plist"),
        plist.build({
          CFBundleDisplayName: "Opensteer",
          CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
          CFBundleName: "$(PRODUCT_NAME)",
          CFBundleExecutable: "$(EXECUTABLE_NAME)",
          CFBundlePackageType: "XPC!",
          CFBundleShortVersionString: "$(MARKETING_VERSION)",
          CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
          NSExtension: {
            NSExtensionPointIdentifier: "com.apple.usernotifications.service",
            NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService",
          },
        }),
      );
      fs.writeFileSync(
        path.join(dir, `${targetName}.entitlements`),
        plist.build({ "com.apple.security.application-groups": [group] }),
      );
      return next;
    },
  ]);
  config = withXcodeProject(config, (next) => {
    project(next.modResults, config);
    return next;
  });
  return withAndroidManifest(config, (next) => {
    manifest(next.modResults);
    return next;
  });
};
module.exports.manifest = manifest;
module.exports.project = project;
