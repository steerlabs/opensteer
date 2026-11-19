/**
 * The framework protocol's snapshot: `packages/plugin-engine/apps/protocols/<protocol>.json`
 * records every message of `protocols/current.ts` as its JSON codec's schema representation, so a
 * change to the boundary between the Host and plugin bundles shows in review and can be checked
 * against the released protocols before it ships.
 *
 *   tsx scripts/plugin-engine/protocol-snapshot.ts           write the current protocol's snapshot
 *   tsx scripts/plugin-engine/protocol-snapshot.ts --check   fail when it is not current, or when a
 *                                                            message the Host sends gained a field
 *                                                            since the previous protocol that
 *                                                            `gates.json` does not gate
 *
 * A snapshot lists the messages that changed since the previous protocol and names the others
 * `unchanged`. A message that contains another whole message refers to it as `{ "$message" }`, and
 * a subtree of at least `sharedBytes` of canonical JSON that occurs more than once is written once
 * under `shared`, keyed by the start of its SHA-256, and referred to as `{ "$shared" }`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema, SchemaRepresentation } from "effect";
import {
  current,
  messageDirections,
} from "../../packages/plugin-engine/apps/src/contracts/protocols/current.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = { [key: string]: Json };
interface Snapshot {
  readonly protocol: number;
  readonly previous: number | null;
  readonly messages: Record<string, Json>;
  readonly unchanged: string[];
  readonly references: Record<string, Json>;
  readonly shared: Record<string, Json>;
}

const directory = fileURLToPath(
  new URL("../../packages/plugin-engine/apps/protocols/", import.meta.url),
);
const sharedBytes = 1_200;
const isNode = (value: Json): value is Node =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** JSON with object keys sorted and no whitespace: what a shared subtree's key hashes. */
const canonical = (value: Json): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : isNode(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
          .join(",")}}`
      : JSON.stringify(value);
const digest = (value: Json) =>
  createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);

/**
 * What a representation says about the wire: annotations other than a check's own message,
 * empty lists other than an object's properties, and defaults (an aborting check, an immutable
 * property) are left out.
 */
const wire = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(wire);
  if (!isNode(value)) return value;
  const out: Node = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "aborted" || (key === "isMutable" && item === false)) continue;
    if (Array.isArray(item) && item.length === 0 && key !== "propertySignatures") continue;
    if (key === "annotations") {
      if (isNode(item) && item.message !== undefined) out[key] = { message: item.message };
      continue;
    }
    out[key] = wire(item);
  }
  return out;
};

/** Each message of the current protocol, with whole other messages referred to by name. */
const currentMessages = () => {
  const represented = Object.fromEntries(
    Object.entries(current.schemas).map(([name, schema]) => {
      const document = SchemaRepresentation.toRepresentation(
        Schema.toCodecJson(schema as Schema.Top).ast,
      );
      return [name, wire(JSON.parse(JSON.stringify(document.representation)) as Json)];
    }),
  );
  const byContent = new Map(
    Object.entries(represented).map(([name, value]) => [canonical(value), name]),
  );
  const refer = (value: Json, root: boolean): Json => {
    if (Array.isArray(value)) return value.map((item) => refer(item, false));
    if (!isNode(value)) return value;
    const message = root ? undefined : byContent.get(canonical(value));
    if (message !== undefined) return { $message: message };
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, refer(item, false)]),
    );
  };
  return Object.fromEntries(
    Object.entries(represented).map(([name, value]) => [name, refer(value, true)]),
  );
};

const read = (protocol: number): Snapshot =>
  JSON.parse(readFileSync(join(directory, `${protocol}.json`), "utf8")) as Snapshot;
/** Every message of a recorded protocol, its shared subtrees written out. */
const recorded = (protocol: number): Record<string, Json> => {
  const snapshot = read(protocol);
  const expand = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(expand);
    if (!isNode(value)) return value;
    if (typeof value.$shared === "string" && Object.keys(value).length === 1)
      return expand(snapshot.shared[value.$shared]!);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  };
  const messages = Object.fromEntries(
    Object.entries(snapshot.messages).map(([name, value]) => [name, expand(value)]),
  );
  if (snapshot.previous === null) return messages;
  const previous = recorded(snapshot.previous);
  for (const name of snapshot.unchanged) messages[name] = previous[name]!;
  return messages;
};

/** Write a subtree that occurs more than once, and is large, once under `shared`. */
const share = (messages: Record<string, Json>) => {
  const counts = new Map<string, number>();
  const count = (value: Json, root: boolean) => {
    if (Array.isArray(value)) return value.forEach((item) => count(item, false));
    if (!isNode(value)) return;
    if (!root) counts.set(digest(value), (counts.get(digest(value)) ?? 0) + 1);
    for (const item of Object.values(value)) count(item, false);
  };
  for (const value of Object.values(messages)) count(value, true);
  const shared: Record<string, Json> = {};
  const replace = (value: Json, root: boolean): Json => {
    if (Array.isArray(value)) return value.map((item) => replace(item, false));
    if (!isNode(value)) return value;
    const inner = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replace(item, false)]),
    );
    const key = digest(value);
    if (root || (counts.get(key) ?? 0) < 2 || canonical(value).length < sharedBytes) return inner;
    shared[key] = inner;
    return { $shared: key };
  };
  const written = Object.fromEntries(
    Object.entries(messages).map(([name, value]) => [name, replace(value, true)]),
  );
  return {
    messages: written,
    shared: Object.fromEntries(
      Object.keys(shared)
        .sort()
        .map((key) => [key, shared[key]!]),
    ),
  };
};

/** The current protocol's snapshot, against the one before it. */
export const protocolSnapshot = (): Snapshot => {
  const protocol = current.version;
  const previousProtocol = protocol - 1;
  const previous = recorded(previousProtocol);
  const messages = currentMessages();
  // A message changed when anything it carries did, another message it contains included.
  const whole = (value: Json, all: Record<string, Json>): Json =>
    Array.isArray(value)
      ? value.map((item) => whole(item, all))
      : !isNode(value)
        ? value
        : typeof value.$message === "string"
          ? whole(all[value.$message]!, all)
          : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, whole(item, all)]));
  const changed = Object.fromEntries(
    Object.entries(messages).filter(
      ([name, value]) =>
        previous[name] === undefined ||
        canonical(whole(previous[name], previous)) !== canonical(whole(value, messages)),
    ),
  );
  const unchanged = Object.keys(messages).filter((name) => !(name in changed));
  const { messages: written, shared } = share(changed);
  return {
    protocol,
    previous: previousProtocol,
    messages: written,
    unchanged,
    references: {},
    shared,
  };
};

/**
 * Properties a message the Host sends gained since the previous protocol, by path. A released
 * bundle may refuse a property it does not know, so each must be gated: sent only to bundles
 * that accept it (`gates.json`).
 */
export const ungatedAdditions = () => {
  const protocol = current.version;
  const before = recorded(protocol - 1);
  const now = currentMessages();
  const gates = (
    JSON.parse(readFileSync(join(directory, "gates.json"), "utf8")) as {
      additions: { message: string; path: string; since: number }[];
    }
  ).additions;
  const resolve = (value: Json, messages: Record<string, Json>): Json =>
    isNode(value) && typeof value.$message === "string" ? messages[value.$message]! : value;
  /** Property names by path; a union's members are told apart by their literal `operation`. */
  const properties = (
    value: Json,
    messages: Record<string, Json>,
    path: string,
    out: Set<string>,
  ) => {
    // Another whole message is checked as itself.
    if (path !== "" && isNode(value) && typeof value.$message === "string") return;
    const node = resolve(value, messages);
    if (!isNode(node)) return;
    if (node._tag === "Union" && Array.isArray(node.types))
      for (const member of node.types) {
        const resolved = resolve(member, messages);
        const operation =
          isNode(resolved) && Array.isArray(resolved.propertySignatures)
            ? resolved.propertySignatures.find(
                (property) => isNode(property) && property.name === "operation",
              )
            : undefined;
        const type = operation !== undefined && isNode(operation) ? operation.type : undefined;
        const literal = type !== undefined && isNode(type) ? type.literal : undefined;
        properties(
          member,
          messages,
          literal === undefined ? path : `${path}operation=${String(literal)}/`,
          out,
        );
      }
    if (Array.isArray(node.propertySignatures))
      for (const property of node.propertySignatures)
        if (isNode(property) && typeof property.name === "string") {
          out.add(`${path}${property.name}`);
          properties(property.type!, messages, `${path}${property.name}/`, out);
        }
  };
  const missing: string[] = [];
  for (const [message, direction] of Object.entries(messageDirections)) {
    if (direction !== "host" || now[message] === undefined || before[message] === undefined)
      continue;
    const was = new Set<string>();
    const is = new Set<string>();
    properties(before[message]!, before, "", was);
    properties(now[message]!, now, "", is);
    for (const path of is)
      if (
        !was.has(path) &&
        !gates.some(
          (gate) => gate.message === message && gate.path === path && gate.since <= protocol,
        )
      )
        missing.push(`${message}: ${path}`);
  }
  return missing;
};

const format = (snapshot: Snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;
const file = join(directory, `${current.version}.json`);

/** Why the recorded snapshot is not the current protocol's, or a change of it is unsafe. */
export const protocolProblems = () => [
  ...(readFileSync(file, "utf8") === format(protocolSnapshot())
    ? []
    : [`${file} is not current: run tsx scripts/plugin-engine/protocol-snapshot.ts`]),
  ...ungatedAdditions().map(
    (addition) => `ungated addition to a message the Host sends: ${addition}`,
  ),
];

if (process.argv[1]?.endsWith("protocol-snapshot.ts")) {
  if (process.argv.includes("--check")) {
    const problems = protocolProblems();
    for (const problem of problems) console.error(problem);
    process.exitCode = problems.length === 0 ? 0 : 1;
  } else writeFileSync(file, format(protocolSnapshot()));
}
