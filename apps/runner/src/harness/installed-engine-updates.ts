import type { HarnessKind } from "@opensteer/core";
import type { InstalledEngineUpdateFacts } from "@opensteer/harness";

/** Installation-specific facts only; ownership policy lives in the shared resolver. */
export const installedEngineUpdateFacts: Partial<Record<HarnessKind, InstalledEngineUpdateFacts>> =
  {
    claude: {
      executableName: "Claude Code",
      homebrew: { cask: "claude-code" },
      minimumVersion: "2.1.294",
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
      minimumVersion: "0.156.0",
      native: {
        realPathIncludes: ["/.codex/packages/standalone/", "/programs/openai/codex/bin/"],
        updateArgs: ["update"],
      },
      packageName: "@openai/codex",
      version: { args: ["--version"], pattern: /codex-cli\s+(\d+\.\d+\.\d+)/m },
    },
    cursor: {
      executableName: "Cursor Agent",
      minimumVersion: "2026.09.10",
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
