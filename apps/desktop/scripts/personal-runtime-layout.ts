/**
 * The release layout is part of the signed contract: the launchers, the Node
 * interpreter, and the PostgreSQL binaries all resolve their own siblings
 * relative to these paths.
 *
 * It lives in its own module because the Runner distribution is cut from an
 * assembled Personal runtime bundle, and both packagers must agree on where
 * each artifact sits rather than restating the paths.
 *
 * The harness runtimes are deliberately absent: where each engine's bytes sit
 * is declared once on its harness catalog entry (`runtime.path`), because the
 * Runner resolves the same path from the same list.
 */
export const personalRuntimeLayout = {
  agentSkills: "agent-skills",
  browserHarnessLauncher: "bin/browser-harness",
  browserHarnessScript: "services/browser-harness.mjs",
  channelRuntimeLauncher: "bin/opensteer-channel-runtime",
  channelRuntimeScript: "services/channel-runtime.mjs",
  hostLauncher: "bin/opensteer-host",
  hostScript: "services/host.mjs",
  interpreter: "node/bin/node",
  nativeFsHelper: "bin/opensteer-native-fs",
  postgres: "postgres",
  runnerLauncher: "bin/opensteer-runner",
  runnerScript: "services/runner.mjs",
  /** Native packages the Host and Runner services load from beside their scripts. */
  serviceModules: "services/node_modules",
  web: "web",
  webManifest: "web/opensteer-web.json",
} as const;
