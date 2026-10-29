import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OpensteerError } from "@opensteer/core";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import type { CodexLaunch } from "./codex-driver.js";
import type { CodexStdioClient } from "./process.js";
import { protocolError, requireObject, requireString } from "./protocol.js";

/**
 * The Codex features a Run has on. Every other feature the executable lists is
 * turned off, so a release that adds a feature, or turns one on by default,
 * changes nothing a Run can do until it is named here.
 */
export const codexApprovedFeatures: ReadonlySet<string> = new Set([
  // Since Codex 0.154.0 the model's `exec` tool runs inside the code-mode host,
  // so turning it off would turn off every command.
  "code_mode_host",
  "compaction_image_budget",
  "content_item_kinds",
  "enable_request_compression",
  // Codex honours a turn's service tier only with this on. A turn names the
  // tier its model selection chose, and clears a previous tier otherwise.
  "fast_mode",
  "guardian_reuse_parent_compaction",
  "in_app_chat",
  "in_app_dictation",
  "in_app_local_automation",
  "mentions_v2",
  // Opensteer leaves Run-local worker scheduling to Codex. Only the current
  // collaboration contract is exposed; the older `multi_agent` tool set is not.
  "multi_agent_v2",
  "shell_snapshot",
  "shell_tool",
  "sleep_tool",
  "system_proxy_fallback",
  "tool_call_mcp_elicitation",
  "unbounded_connection_retries",
  "unified_exec",
  "unified_exec_tty",
  "view_image",
  "worktrees",
]);

/** Every configurable feature mapped to whether a Run has it on. */
export type CodexFeatureBoundary = Readonly<Record<string, boolean>>;

const featureNamePattern = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/u;
const featureListTimeoutMs = 30_000;
const featureListPageLimit = 16;
const configurableFeatures = new Map<string, Promise<readonly string[]>>();

/**
 * The boundary for one Codex executable, read once from the executable itself.
 * The read runs in an empty home so neither the person's configuration nor a
 * profile's can add a feature to the list or hide one from it.
 */
export async function codexFeatureBoundary(launch: CodexLaunch): Promise<CodexFeatureBoundary> {
  const key = [executableIdentity(launch.executable), ...launch.arguments].join("\0");
  let names = configurableFeatures.get(key);
  if (!names) {
    names = readConfigurableFeatures(launch);
    configurableFeatures.set(key, names);
    names.catch(() => configurableFeatures.delete(key));
  }
  return Object.fromEntries((await names).map((name) => [name, codexApprovedFeatures.has(name)]));
}

/**
 * One inline table rather than a `-c` per feature: a feature name may hold a
 * dot, which a dotted override path would read as a nested table.
 */
export function codexFeatureBoundaryArgument(boundary: CodexFeatureBoundary): string {
  const entries = Object.entries(boundary).map(
    ([name, enabled]) => `${JSON.stringify(name)}=${String(enabled)}`,
  );
  return `features={${entries.join(",")}}`;
}

/**
 * Codex's own account of what is on in this process. A managed policy, or a
 * feature that keeps another on, can override what Opensteer asked for, and
 * only the effective state shows it.
 */
export async function assertCodexFeatureBoundary(
  client: CodexStdioClient,
  boundary: CodexFeatureBoundary,
  timeoutMs: number,
): Promise<void> {
  const conflicting: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page === featureListPageLimit) {
      throw protocolError("Codex experimentalFeature/list kept paging without finishing");
    }
    const result = requireObject(
      await client.request(
        "experimentalFeature/list",
        cursor === undefined ? {} : { cursor },
        timeoutMs,
      ),
      "experimentalFeature/list result",
    );
    if (!Array.isArray(result.data)) {
      throw protocolError("Codex experimentalFeature/list result.data must be an array");
    }
    for (const value of result.data) {
      const feature = requireObject(value, "experimentalFeature/list feature");
      const name = requireString(feature.name, "experimentalFeature/list feature.name");
      if (feature.stage === "removed") continue;
      if (typeof feature.enabled !== "boolean") {
        throw protocolError(`Codex did not report whether ${name} is enabled`);
      }
      if (feature.enabled !== (boundary[name] ?? false)) conflicting.push(name);
    }
    if (result.nextCursor === null || result.nextCursor === undefined) break;
    cursor = requireString(result.nextCursor, "experimentalFeature/list nextCursor");
  }
  if (conflicting.length > 0) {
    throw new OpensteerError({
      code: "forbidden",
      message: `Local Codex policy conflicts with the Opensteer feature boundary: ${conflicting.join(", ")}`,
    });
  }
}

/**
 * A person's CLI is updated in place, so the list is keyed by the file that
 * runs and its modification, not by the path that names it.
 */
function executableIdentity(executable: string): string {
  try {
    const file = realpathSync(executable);
    const { mtimeMs, size } = statSync(file);
    return `${file}\0${mtimeMs}\0${size}`;
  } catch {
    return executable;
  }
}

async function readConfigurableFeatures(launch: CodexLaunch): Promise<readonly string[]> {
  const home = await mkdtemp(join(tmpdir(), "opensteer-codex-features-"));
  try {
    const { stdout } = await promisify(execFile)(
      launch.executable,
      [...launch.arguments, "features", "list"],
      {
        env: { CODEX_HOME: home, HOME: home, PATH: process.env.PATH ?? "" },
        maxBuffer: 1024 * 1024,
        timeout: featureListTimeoutMs,
      },
    );
    return parseFeatureTable(stdout);
  } catch (error) {
    if (error instanceof OpensteerError) throw error;
    throw new OpensteerError({
      cause: error,
      // Inspection reports a missing executable as an engine that is not
      // installed, never as a fault.
      code: nodeErrorCode(error) === "ENOENT" ? "not_found" : "harness_error",
      message: `Codex could not list its features: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}

/**
 * `codex features list` prints one feature per line: its name, its stage (which
 * may be two words), and whether it is on. A removed feature no longer gates
 * anything, so it is left out of the boundary.
 */
function parseFeatureTable(output: string): readonly string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/u);
    const name = columns[0] ?? "";
    if (columns.length === 1 && name === "") continue;
    const enabled = columns.at(-1);
    if (
      columns.length < 3 ||
      !featureNamePattern.test(name) ||
      (enabled !== "true" && enabled !== "false")
    ) {
      throw protocolError(`Codex listed a feature Opensteer cannot read: ${line.slice(0, 200)}`);
    }
    if (columns.slice(1, -1).join(" ") !== "removed") names.push(name);
  }
  if (names.length === 0) throw protocolError("Codex listed no features");
  return names;
}
