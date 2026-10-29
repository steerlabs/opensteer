import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const banned = [
  /secrets\s*(?:\.|\[)/i,
  /pull_request_target/i,
  /id-token['"]?\s*:\s*['"]?write/i,
  /self-hosted/i,
  /\benvironments?['"]?\s*:/i,
];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function rejectBanned(text) {
  for (const pattern of banned)
    if (pattern.test(text)) throw new Error(`Unsafe workflow surface: ${pattern}`);
}

/** No public CI caller allows writes. Any exception must name its exact scope
 * at a reviewed call site; it cannot exempt write-all or the other safety rules. */
export function assertForkSafe(text, { allowedWriteScopes = [] } = {}) {
  rejectBanned(text);
  const document = parseDocument(text);
  if (document.errors.length || document.warnings.length) throw new Error("Invalid workflow YAML");
  const workflow = document.toJS();
  if (!record(workflow)) throw new Error("Expected workflow/action mapping");
  const localActions = new Set();
  const visited = new Set();
  const walk = (node) => {
    if (typeof node === "string") {
      rejectBanned(node);
      return;
    }
    if (node === null || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Object.hasOwn(node, "permissions")) {
      const permissions = node.permissions;
      if (permissions !== "read-all") {
        if (!record(permissions)) throw new Error("Permissions must be read-only scopes");
        for (const [scope, value] of Object.entries(permissions))
          if (
            value !== "read" &&
            value !== "none" &&
            !(value === "write" && allowedWriteScopes.includes(scope))
          )
            throw new Error(`Unreviewed permission: ${scope}: ${value}`);
      }
    }
    if (Object.hasOwn(node, "uses")) {
      const action = node.uses;
      if (typeof action !== "string") throw new Error("Invalid action reference");
      if (action.startsWith("./")) localActions.add(action);
      else if (!/^[\w-]+\/[\w/.-]+@[a-f0-9]{40}$/.test(action))
        throw new Error(`Unpinned action: ${action}`);
      if (/^actions\/checkout@/i.test(action)) {
        const persist = node.with?.["persist-credentials"];
        if (persist !== false && persist !== "false")
          throw new Error("Checkout requires persist-credentials: false");
      }
    }
    for (const [key, value] of Object.entries(node)) {
      rejectBanned(key);
      walk(value);
    }
  };
  walk(workflow);
  return [...localActions];
}

/** Scan the transitive local-action closure, without executing fork code. */
export function checkWorkflows(files, { root = process.cwd() } = {}) {
  const checkout = realpathSync(root);
  const visited = new Set();
  const scan = (file) => {
    const canonical = realpathSync(file);
    const path = relative(checkout, canonical);
    if (path === ".." || path.startsWith(".." + sep))
      throw new Error("Local action escapes checkout");
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const action of assertForkSafe(readFileSync(canonical, "utf8"))) {
      const directory = resolve(checkout, action);
      const yaml = resolve(directory, "action.yml");
      scan(existsSync(yaml) ? yaml : resolve(directory, "action.yaml"));
    }
  };
  files.forEach((file) => scan(resolve(checkout, file)));
  return [...visited].map((file) => relative(checkout, file)).sort();
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(`Fork safety checked: ${checkWorkflows(process.argv.slice(2)).join(", ")}`);
