import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadAccessMode } from "@opensteer/core";
import { cursorHookProgramFileName, cursorHookProgramSource } from "./hook-program.js";

/**
 * The plugin directory's basename is part of every MCP tool id the model sees:
 * a server `opensteer` inside a plugin directory `plug` became
 * `plugin-plug-opensteer` and its tools `plugin-plug-opensteer-<tool>`
 * (cursor-facts §A.7, open risk 5). It is fixed here so the vocabulary the
 * platform guide names is the vocabulary the model gets.
 */
export const cursorPluginDirectoryName = "opensteer";

export const cursorAgentToolsServerName = "opensteer";
export const cursorIntegrationToolsServerName = "opensteer_integrations";

/** What `beforeMCPExecution` calls our two servers. */
export function cursorMcpServerIdentifier(serverName: string): string {
  return `plugin-${cursorPluginDirectoryName}-${serverName}`;
}

export const cursorOpensteerMcpServerIdentifiers: readonly string[] = [
  cursorMcpServerIdentifier(cursorAgentToolsServerName),
  cursorMcpServerIdentifier(cursorIntegrationToolsServerName),
];

/**
 * Cursor's hook events, as the gate for one access mode.
 *
 * Print mode has no approval channel of its own: the built-in permission
 * system can only deny, never ask, because stdout is one-way and stdin is
 * never read (cursor-facts §A.5). Hooks are the whole approval surface, and a
 * hook overrides `--force`, so the modes differ only in which events are
 * gated.
 *
 * `preToolUse` fires for every tool, which is what makes it the catch-all: it
 * gates file edits, and it is also the only event that sees a tool this build
 * has never heard of. The CLI installs itself and accepts releases newer than
 * the one the driver was written against, so a mutating tool Cursor adds later
 * must reach a person rather than run unannounced — which is why both gated
 * modes install it and the driver answers by name (`cursorPreToolUseDecision`)
 * rather than by omission. `beforeMCPExecution` gates other people's MCP
 * servers; Opensteer's own two are always allowed, exactly as for Codex.
 */
export type CursorHookEvent = "beforeShellExecution" | "beforeMCPExecution" | "preToolUse";

export function cursorAccessModeHooks(accessMode: ThreadAccessMode): readonly CursorHookEvent[] {
  switch (accessMode) {
    case "approval-required":
    case "auto-accept-edits":
      return ["beforeShellExecution", "beforeMCPExecution", "preToolUse"];
    case "full-access":
      return [];
    case "auto":
      throw new Error("Cursor does not declare the auto access mode");
  }
}

/**
 * Cursor's own name for a tool in a `preToolUse` payload. It is the vocabulary
 * the shipped bundle remaps Claude's hook names onto (`Bash→Shell`,
 * `Edit/Write→Write`, `Grep→Grep`), and `Shell`, `Read`, `Write` and
 * `MCP:<tool>` were all observed live.
 */
const cursorReadOnlyTools = new Set(["Read", "Grep", "Glob", "Search"]);
const cursorFileChangeTools = new Set(["Write", "Edit"]);

export type CursorPreToolUseDecision = "allow" | "file-change" | "unknown-tool";

/**
 * What `preToolUse` should do with one tool, for one access mode.
 *
 * `Shell` and `MCP:` calls are allowed here because `beforeShellExecution` and
 * `beforeMCPExecution` gate the same call a moment later — answering both
 * would open two Requests for one action. Everything this build cannot name is
 * treated as mutating.
 */
export function cursorPreToolUseDecision(
  accessMode: ThreadAccessMode,
  toolName: string,
): CursorPreToolUseDecision {
  if (toolName === "Shell" || toolName.startsWith("MCP:")) return "allow";
  if (cursorReadOnlyTools.has(toolName)) return "allow";
  if (cursorFileChangeTools.has(toolName)) {
    return accessMode === "approval-required" ? "file-change" : "allow";
  }
  return "unknown-tool";
}

export interface CursorPluginPlan {
  readonly accessMode: ThreadAccessMode;
  /** No MCP configuration; the catch-all hook denies every title tool call. */
  readonly titleOnly?: true;
  readonly agentTools: { readonly token: string; readonly url: string };
  readonly hookSocketPath: string;
  readonly hookTimeoutSeconds: number;
  readonly integrationTools: { readonly token: string; readonly url: string };
  /** The Runner's own Node, never `process.execPath`: that is Electron in the desktop app. */
  readonly nodeExecutable: string;
  readonly threadStateDirectory: string;
}

export interface CursorPlugin {
  readonly hookProgramPath: string;
  readonly path: string;
}

/**
 * Writes the Run's plugin directory. The MCP file carries the two bearer
 * tokens, so it is the one file written at mode 0600: Cursor hands the harness
 * process environment to the commands the model runs, which is why the tokens
 * travel in a file it reads rather than in a variable (cursor-facts §A.7).
 */
export async function materializeCursorPlugin(plan: CursorPluginPlan): Promise<CursorPlugin> {
  const path = join(plan.threadStateDirectory, cursorPluginDirectoryName);
  const hooksDirectory = join(path, "hooks");
  await mkdir(join(path, ".cursor-plugin"), { mode: 0o700, recursive: true });
  await mkdir(hooksDirectory, { mode: 0o700, recursive: true });

  await writeFile(
    join(path, ".cursor-plugin", "plugin.json"),
    `${JSON.stringify({ name: cursorPluginDirectoryName, version: "1.0.0" }, undefined, 2)}\n`,
  );

  await replacePrivateFileAtomically(
    join(path, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: plan.titleOnly
          ? {}
          : {
              [cursorAgentToolsServerName]: {
                headers: { Authorization: `Bearer ${plan.agentTools.token}` },
                url: plan.agentTools.url,
              },
              [cursorIntegrationToolsServerName]: {
                headers: { Authorization: `Bearer ${plan.integrationTools.token}` },
                url: plan.integrationTools.url,
              },
            },
      },
      undefined,
      2,
    )}\n`,
  );

  const hookProgramPath = join(hooksDirectory, cursorHookProgramFileName);
  await writeFile(hookProgramPath, cursorHookProgramSource);
  await setFileMode(hookProgramPath, 0o600);

  await writeFile(
    join(hooksDirectory, "hooks.json"),
    `${JSON.stringify(
      {
        hooks: Object.fromEntries(
          cursorAccessModeHooks(plan.accessMode).map((event) => [
            event,
            [
              {
                command: cursorHookCommand(
                  plan.nodeExecutable,
                  hookProgramPath,
                  plan.hookSocketPath,
                ),
                failClosed: true,
                timeout: plan.hookTimeoutSeconds,
                type: "command",
              },
            ],
          ]),
        ),
        version: 1,
      },
      undefined,
      2,
    )}\n`,
  );

  return { hookProgramPath, path };
}

/**
 * Cursor runs a command hook through a shell, so every path is quoted rather
 * than passed as argv. The socket path travels as an argument because the
 * hook's environment is Cursor's to build, not the driver's.
 */
export function cursorHookCommand(
  nodeExecutable: string,
  hookProgramPath: string,
  hookSocketPath: string,
): string {
  return [nodeExecutable, hookProgramPath, hookSocketPath].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
