import type { harnessCatalog } from "@opensteer/core";
import type { InstalledEngineUpdateFacts } from "@opensteer/harness";

/** Every catalog engine a person can install themselves, as its own runtime or beside shipped bytes. */
type InstalledEngineKind = Extract<
  (typeof harnessCatalog)[number],
  { readonly runtime: { readonly shape: "installed" } } | { readonly installed: object }
>["kind"];

/**
 * Installation-specific facts only; ownership policy lives in the shared
 * resolver and the minimum version in the catalog. Keyed exhaustively, so an
 * installed engine without facts is a compile error rather than an engine the
 * Runner never locates.
 */
export const installedEngineUpdateFacts: Record<
  InstalledEngineKind,
  Omit<InstalledEngineUpdateFacts, "minimumVersion">
> = {
  claude: {
    executableName: "Claude Code",
    homebrew: { cask: "claude-code" },
    native: {
      realPathIncludes: ["/.local/share/claude/versions/"],
      updateArgs: ["update"],
    },
    packageName: "@anthropic-ai/claude-code",
    version: { args: ["--version"], pattern: /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/m },
  },
  codex: {
    executableName: "Codex",
    homebrew: { cask: "codex" },
    native: {
      realPathIncludes: ["/.codex/packages/standalone/", "/programs/openai/codex/bin/"],
      updateArgs: ["update"],
    },
    packageName: "@openai/codex",
    version: { args: ["--version"], pattern: /codex-cli\s+(\d+\.\d+\.\d+)/m },
  },
  grok: {
    executableName: "Grok",
    homebrew: { cask: "grok-build" },
    native: { realPathIncludes: ["/.grok/bin/"], updateArgs: ["update"] },
    packageName: "@xai-official/grok",
    // npm 12 refuses the package's install script unless it is named here.
    updateEnvironment: { npm_config_allow_scripts: "@xai-official/grok" },
    version: { args: ["--version"], pattern: /^grok\s+(\d+\.\d+\.\d+)/m },
  },
  muse: {
    comparison: "revision",
    executableName: "Muse Code",
    latest: {
      channelEnvironment: "MUSE_CHANNEL",
      channels: { canary: "muse-canary", stable: "muse-stable" },
      defaultChannel: "stable",
      kind: "channel-manifest",
      url: "https://api.meta.ai/muse-code/channels/{channel}",
      versionField: "version",
    },
    // Muse's launcher updates itself synchronously when asked to on any
    // invocation; `--version` is the cheapest one.
    native: {
      launcherFile: { contains: ["muse-code/launcher-", "MUSE_SYNC_UPDATE"], maxBytes: 128 * 1024 },
      updateArgs: ["--version"],
    },
    updateEnvironment: {
      MUSE_NO_AUTO_UPDATE: "0",
      MUSE_SYNC_UPDATE: "1",
      MUSE_UPDATE_INTERVAL_SECONDS: "0",
    },
    version: { args: ["--version"], pattern: /\((\d+\.\d+\.\d+(?:-R[\d.]+)?)\)/m },
  },
  cursor: {
    executableName: "Cursor Agent",
    native: {
      realPathIncludes: ["/.local/share/cursor-agent/versions/"],
      updateArgs: ["update"],
    },
    version: {
      args: ["--version"],
      pattern: /(?:^|\s)(\d{4}\.\d{2}\.\d{2}(?:-[a-zA-Z0-9.-]+)?)(?:\s|$)/m,
    },
  },
};
