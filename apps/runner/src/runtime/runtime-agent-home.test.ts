import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * What a Run may reach on disk is decided in one place, `RunnerRuntime.#runFolders`, from whether
 * it has personal context. This reads every Runner source file for a use of Agent home's path and
 * fails on one outside that place, unless it is listed here with why it is not on a Run's behalf.
 *
 * It sees, on a prepared workspace or anything named for Agent home (`workspace`, `agentHome`,
 * `settingsHome`, `folders.agentHome`): `.path` and `?.path`, a parenthesized expression's
 * `).path`, bracket access (`["path"]`), and `path` destructured (`const { path } = workspace`).
 *
 * What it still cannot see: an alias under another name (`const home = workspace; home.path`),
 * a path passed to a helper that reads it elsewhere, and code outside `apps/runner/src`.
 */
const root = path.resolve(import.meta.dirname, "..");
const runFolders = "runtime/runtime.ts";

/** Uses that are the Runner's own, never a Run's, by file and line, each with why. */
const notForARun: Readonly<Record<string, string>> = {
  "runtime/runtime.ts: if (workspace) this.#settingsHome = workspace.path;":
    "The Runner's own settings home, read for its engines' defaults, outside any Run.",
  "runtime/runtime.ts: await this.#scanAgentHomeSkills(workspace.path, context.bindingGeneration).catch(":
    "After a Run with personal context ends, the person's skill catalog is refreshed for the Home; nothing reaches the Run.",
  "runtime/runtime.ts: ).path;":
    "The Runner's own settings home, prepared without personal context when no canonical folder is kept (`#ensureSettingsHome`).",
  'folders/agent-home.ts: if (!isAbsolute(agentHome.path) || agentHome.path.includes("\\0"))':
    "Agent home's own manager, checking the folder it is handed before anything uses it.",
  "folders/agent-home.ts: if (requireCanonical) await assertCanonicalAncestors(agentHome.path);":
    "The same check, of the folder's ancestors.",
  "folders/agent-home.ts: await mkdir(agentHome.path, { recursive: true });":
    "The manager making the folder; what a Run reaches is still decided in #runFolders.",
  "folders/agent-home.ts: const canonical = await realpath(agentHome.path);":
    "The manager resolving the folder it made.",
  "folders/agent-home.ts: if (requireCanonical && canonical !== agentHome.path)":
    "The same check, that the folder still resolves to itself.",
  "folders/agent-home.ts: throw new Error(`Agent home ${agentHome.path} now resolves to ${canonical}. Restore it.`);":
    "Its refusal names the folder.",
  "folders/agent-home.ts: throw new Error(`${agentHome.path} is not a folder`);":
    "Its refusal names the folder.",
  "folders/agent-home.ts: if (path !== agentHome.path)":
    "The manager checking that a folder it resolved is still Agent home.",
  "folders/agent-home.ts: throw new Error(`Agent home ${agentHome.path} now resolves to ${path}. Restore it.`);":
    "Its refusal names the folder.",
  "triggers/watch-supervisor.ts: workspacePath: workspace.path,":
    "A watch's script working folder, which the Host activates only for a lineage with personal context (`triggerLaunchStanding`).",
  "triggers/watch-supervisor.ts: )({ args, cwd: workspace.path, environment, executable });":
    "The same watch script's working folder.",
  "apps/app-server-manager.ts: left.agentHome.path === right.agentHome.path":
    "Whether two app servers share a home, compared; nothing is opened.",
  "agent/script-executor.ts: workspacePath: input.workspace.path,":
    "An automation's script, which the Host launches only for a lineage with personal context (`triggerLaunchStanding`).",
  "agent/script-executor.ts: cwd: input.workspace.path,": "The same script's working folder.",
};

const named = String.raw`(?:workspace|\w*[aA]gentHome\w*|\w*settingsHome\w*|folders\??\.agentHome)`;
const forms = [
  new RegExp(String.raw`\b${named}\??\.path\b`, "gu"),
  new RegExp(String.raw`\)\??\.path\b`, "gu"),
  new RegExp(String.raw`\b${named}\??\.?\[\s*["']path["']\s*\]`, "gu"),
  new RegExp(String.raw`\{[^}]*\bpath\b[^}]*\}\s*=\s*(?:await\s+)?[\w.#]*${named}`, "gu"),
];

function* sources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (entry.name.endsWith(".ts") && !/\.test\.|test-support|\.d\.ts$/u.test(entry.name))
      yield full;
  }
}

/** Each use outside #runFolders, as `file: line`. */
function uses(): readonly string[] {
  const found = new Set<string>();
  for (const file of sources(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const source = readFileSync(file, "utf8");
    const start = relative === runFolders ? source.indexOf("  async #runFolders(") : -1;
    const end = start < 0 ? -1 : source.indexOf("\n  }\n", start);
    for (const form of forms)
      for (const match of source.matchAll(form)) {
        if (match.index > start && match.index < end) continue;
        // A `).path` is Agent home's only where what it closes names it.
        const lineStart = source.lastIndexOf("\n", match.index) + 1;
        const line = source.slice(lineStart, source.indexOf("\n", match.index)).trim();
        if (
          form === forms[1] &&
          !new RegExp(named, "u").test(source.slice(Math.max(0, match.index - 400), match.index))
        )
          continue;
        found.add(`${relative}: ${line}`);
      }
  }
  return [...found];
}

it("reads Agent home's path for a Run only in #runFolders", () => {
  expect(uses().filter((use) => !(use in notForARun))).toEqual([]);
});

it("lists only uses that are still there", () => {
  const now = new Set(uses());
  expect(Object.keys(notForARun).filter((use) => !now.has(use))).toEqual([]);
});

it("finds each form it knows", () => {
  expect(readFileSync(new URL(import.meta.url), "utf8")).toContain("#runFolders");
  const sample = [
    "const a = workspace.path;",
    "const b = (await this.#agentHome.prepare(x)).path;",
    'const c = workspace["path"];',
    "const { path } = workspace;",
  ].join("\n");
  const hits = forms.flatMap((form) => [...sample.matchAll(form)].map((match) => match[0]));
  expect(hits).toHaveLength(4);
});
