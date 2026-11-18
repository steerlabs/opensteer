import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseModule } from "@babel/parser";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/**
 * Screens show content, a neutral placeholder or a fact about their own
 * resource or action; connection trouble has one voice, the shell's. These
 * rules keep the raw failure out of UI code so a screen cannot put exception
 * text, or its own account of the connection, in front of a person.
 */

/** Turn an arbitrary failure into words: its text, or a pre-presenter guess at it. */
const rawPresenters = new Set([
  "presentActionFailure",
  "clientPublicDetail",
  "operationDetail",
  "safeMessage",
  "operationFailure",
  "failureNotice",
]);

/** Failure classes a screen would only import to branch on, or print, a raw failure. */
const transportErrors = new Set([
  "HostTransportError",
  "HostClientRequestError",
  "ClientOperationError",
  "CapabilityVerificationError",
  "OpensteerError",
  "HostSessionError",
  "HostSessionExchangeError",
]);

/** The connection's own words, said only by the shell's pill and the gates. */
const connectionNotices = new Set([
  "connectionNotice",
  "useConnectionNotice",
  "describeHostConnection",
  "showsHostLive",
  "presentConnectionGate",
  "presentConnectionStarting",
]);

/**
 * Modules under the UI roots that are a boundary, not a screen. Keep this
 * short; every entry says why it may see what screens may not.
 */
const boundaryModules: readonly { readonly prefix: string; readonly reason: string }[] = [
  {
    prefix: "apps/web/src/host/",
    reason: "the web's HostClient, transport and outbox ports: where failures are classified",
  },
  {
    prefix: "apps/web/src/desktop/desktop-host-transport.ts",
    reason: "Desktop IPC transport: rebuilds typed failures from main's answers",
  },
  {
    prefix: "apps/web/src/team/team-transports.ts",
    reason: "team session transports: classify team server failures for the session",
  },
  {
    prefix: "apps/web/src/team/team-coordination.ts",
    reason: "Desktop IPC adapters for Account teams and team sessions: rebuild typed failures",
  },
  {
    prefix: "apps/web/src/team/team-attachments.tsx",
    reason: "attaches team sessions and turns their typed refusals into each team's state",
  },
  {
    prefix: "apps/web/src/desktop/desktop-preview-bridge.ts",
    reason: "the preview build's stand-in for Electron main, which owns these failures",
  },
  {
    prefix: "apps/web/src/attachments-visual.tsx",
    reason: "a development visual harness that fakes Host refusals",
  },
  {
    prefix: "apps/mobile/src/client/",
    reason: "the mobile client's composition root (sessions, transports, saved-view labels)",
  },
  {
    prefix: "apps/mobile/src/team/mobile-teams.ts",
    reason: "the phone's team sessions owner; turns typed team refusals into each team's state",
  },
  {
    prefix: "apps/mobile/src/team/team-coordinator-ports.ts",
    reason: "Account and team session ports; rebuild typed failures for the coordinator",
  },
  {
    prefix: "apps/mobile/src/phone-browser/android-port.ts",
    reason: "this phone as an agent browser: words Android's errors for the Host's wire",
  },
  {
    prefix: "apps/mobile/src/phone-browser/iphone-port.ts",
    reason: "this phone as an agent browser: words iOS's errors for the Host's wire",
  },
  {
    prefix: "apps/mobile/src/phone-browser/agent-helper/",
    reason: "a script injected into the agent's page; its answers go to the agent over CDP",
  },
  {
    prefix: "apps/mobile/src/phone-browser/manager.ts",
    reason: "this phone's browser sessions for agents: CDP router failures go to the Host",
  },
  {
    prefix: "apps/mobile/src/ui/client-feedback.ts",
    reason: "mobile feedback over ClientAction; builds the typed refusal an answer carries in-band",
  },
];

/** The shell and gate adapters: the only modules that read connection notices. */
const shellAdapters: readonly { readonly prefix: string; readonly reason: string }[] = [
  {
    prefix: "apps/web/src/components/connection-shell.tsx",
    reason: "web and desktop pill, sidebar dot and gates",
  },
  {
    prefix: "apps/mobile/src/ui/connection-live.ts",
    reason: "mobile shell; the pill, details sheet and gates read connection notices here",
  },
  {
    prefix: "apps/mobile/src/ui/route-gate.tsx",
    reason: "mobile route gate: a route's one explanation while it has nothing to show",
  },
  {
    prefix: "apps/mobile/src/team/team-screen-gate.tsx",
    reason: "mobile team gate: a team route's one explanation while it has nothing to show",
  },
];

/**
 * Every non-test source a person's screen is drawn from. The shared client's
 * view state outside its hooks carries typed issues, so a screen can only say
 * it through the presenter.
 */
function uiModules(): string[] {
  return [
    ...sourcesUnder("apps/web/src"),
    ...sourcesUnder("apps/mobile/src"),
    // Shared hooks hand their state straight to screens on every surface.
    ...sourcesUnder("packages/client/src/react"),
    // Desktop main has no screens; a renderer module there would be UI.
    ...sourcesUnder("apps/desktop/src").filter((file) => file.endsWith(".tsx")),
  ].filter((file) => !/\/(?:tests|journey)\//u.test(file));
}

function sourcesUnder(directory: string): string[] {
  const absolute = path.join(repositoryRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !/\.(?:test|test-support|fixture)\.tsx?$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts"),
    )
    .map((entry) =>
      path.posix.join(
        directory,
        path.relative(absolute, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
      ),
    );
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule:
    | "raw-presenter"
    | "transport-error"
    | "connection-notice"
    | "message-unwrap"
    | "message-fallback";
  readonly name: string;
}

/** A TypeScript syntax node, as Babel's TypeScript parser gives it. */
interface SyntaxNode {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number } } | null;
  readonly [key: string]: unknown;
}

interface Parsed {
  readonly file: string;
  readonly program: SyntaxNode;
}

function parse(file: string, text: string): Parsed {
  const syntax = parseModule(text, {
    sourceType: "module",
    plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    attachComment: false,
    errorRecovery: true,
  });
  return { file, program: syntax.program as unknown as SyntaxNode };
}

function isNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" && value !== null && typeof (value as SyntaxNode).type === "string"
  );
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "extra") continue;
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) walk(value, visit);
  }
}

/** An import or export specifier's name, whether written as an identifier or a string. */
function nameOf(value: unknown): string {
  if (!isNode(value)) return "";
  return String(value["name"] ?? value["value"] ?? "");
}

/** The property a member expression reads: `a.b`, `a?.b` and `a["b"]` all read `b`. */
function memberName(node: unknown): string | null {
  if (
    !isNode(node) ||
    (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression")
  )
    return null;
  const property = node["property"];
  if (!node["computed"]) return nameOf(property);
  return isNode(property) && property.type === "StringLiteral" ? nameOf(property) : null;
}

const statements = (program: SyntaxNode) => program["body"] as readonly SyntaxNode[];
const specifiers = (node: SyntaxNode) => (node["specifiers"] ?? []) as readonly SyntaxNode[];

type ImportRule = "raw-presenter" | "transport-error" | "connection-notice";
const originals = new Map<string, ImportRule>([
  ...[...rawPresenters].map((name) => [name, "raw-presenter"] as const),
  ...[...transportErrors].map((name) => [name, "transport-error"] as const),
  ...[...connectionNotices].map((name) => [name, "connection-notice"] as const),
]);

/**
 * Where a module's imports lead. A forbidden binding is the shared packages'
 * own: imported from `@opensteer/*` or their source, or re-exported, under
 * any name, by a UI module. A same-named export of an unrelated module is not.
 */
interface ModuleGraph {
  /** The forbidden bindings each UI module exports, by the names it exports them as. */
  readonly exports: Map<string, Map<string, ImportRule>>;
  readonly isUiModule: (file: string) => boolean;
  /** The repository file a relative specifier names, or null when there is none. */
  readonly resolve: (from: string, source: string) => string | null;
}

function importedRule(
  graph: ModuleGraph,
  from: string,
  source: string,
  name: string,
): ImportRule | null {
  if (source.startsWith("@opensteer/")) return originals.get(name) ?? null;
  if (!source.startsWith(".")) return null;
  const target = graph.resolve(from, source);
  if (target === null) return null;
  return graph.isUiModule(target)
    ? (graph.exports.get(target)?.get(name) ?? null)
    : (originals.get(name) ?? null);
}

/** Every forbidden binding a module's imports bring in, by local name. */
function importedBindings(graph: ModuleGraph, parsed: Parsed): Map<string, ImportRule> {
  const bound = new Map<string, ImportRule>();
  for (const statement of statements(parsed.program)) {
    if (statement.type !== "ImportDeclaration" || statement["importKind"] === "type") continue;
    const source = nameOf(statement["source"]);
    for (const specifier of specifiers(statement)) {
      if (specifier.type !== "ImportSpecifier" || specifier["importKind"] === "type") continue;
      const rule = importedRule(graph, parsed.file, source, nameOf(specifier["imported"]));
      if (rule) bound.set(nameOf(specifier["local"]), rule);
    }
  }
  return bound;
}

/** Follows re-exports through barrels, renamed or not, until nothing new is exported. */
function exportsOf(
  files: readonly Parsed[],
  graph: Omit<ModuleGraph, "exports">,
): Map<string, Map<string, ImportRule>> {
  const exports = new Map(files.map(({ file }) => [file, new Map<string, ImportRule>()]));
  const full: ModuleGraph = { ...graph, exports };
  for (let grew = true; grew;) {
    grew = false;
    for (const parsed of files) {
      const mine = exports.get(parsed.file)!;
      const add = (name: string, rule: ImportRule | null | undefined) => {
        if (!rule || mine.has(name)) return;
        mine.set(name, rule);
        grew = true;
      };
      const bound = importedBindings(full, parsed);
      for (const statement of statements(parsed.program)) {
        if (statement["exportKind"] === "type") continue;
        const source = isNode(statement["source"]) ? nameOf(statement["source"]) : null;
        if (statement.type === "ExportNamedDeclaration")
          for (const specifier of specifiers(statement)) {
            if (specifier.type !== "ExportSpecifier" || specifier["exportKind"] === "type")
              continue;
            const local = nameOf(specifier["local"]);
            add(
              nameOf(specifier["exported"]),
              source === null ? bound.get(local) : importedRule(full, parsed.file, source, local),
            );
          }
        if (
          statement.type === "ExportAllDeclaration" &&
          source !== null &&
          !statement["exported"]
        ) {
          const target = source.startsWith(".") ? graph.resolve(parsed.file, source) : null;
          const all =
            target !== null && graph.isUiModule(target)
              ? (exports.get(target) ?? new Map<string, ImportRule>())
              : source.startsWith("@opensteer/") || target !== null
                ? originals
                : new Map<string, ImportRule>();
          for (const [name, rule] of all) add(name, rule);
        }
      }
    }
  }
  return exports;
}

/** The names of errors an `x instanceof Error` test proves, anywhere inside it. */
function testedErrors(test: unknown): Set<string> {
  const tested = new Set<string>();
  if (!isNode(test)) return tested;
  walk(test, (inner) => {
    if (
      inner.type === "BinaryExpression" &&
      inner["operator"] === "instanceof" &&
      isNode(inner["left"]) &&
      inner["left"].type === "Identifier" &&
      nameOf(inner["right"]) === "Error"
    )
      tested.add(nameOf(inner["left"]));
  });
  return tested;
}

/** Whether a statement always leaves the block it is in. */
function exits(statement: unknown): boolean {
  if (!isNode(statement)) return false;
  if (
    ["ReturnStatement", "ThrowStatement", "ContinueStatement", "BreakStatement"].includes(
      statement.type,
    )
  )
    return true;
  const body = statement.type === "BlockStatement" ? (statement["body"] as unknown[]) : [];
  return body.length > 0 && exits(body.at(-1));
}

/** What one module does that the rules forbid. */
function violationsIn(parsed: Parsed, graph: ModuleGraph, allowNotices = false): Violation[] {
  const { file, program } = parsed;
  const found: Violation[] = [];
  const flag = (node: SyntaxNode, name: string, rule: ImportRule | null) => {
    if (rule && !(allowNotices && rule === "connection-notice"))
      found.push({ file, line: node.loc?.start.line ?? 0, rule, name });
  };
  // Namespace imports are read through their members: `feedback.presentActionFailure`.
  const namespaces = new Map<string, string>();
  // Results branched on `.ok`: an RPC or bridge result, whose failed `.error.message` is raw.
  const results = new Set<string>();
  walk(program, (node) => {
    if (memberName(node) === "ok" && isNode(node["object"]) && node["object"].type === "Identifier")
      results.add(nameOf(node["object"]));
  });
  for (const statement of statements(program)) {
    const source = isNode(statement["source"]) ? nameOf(statement["source"]) : "";
    if (statement.type === "ImportDeclaration" && statement["importKind"] !== "type") {
      for (const specifier of specifiers(statement)) {
        if (specifier.type === "ImportNamespaceSpecifier")
          namespaces.set(nameOf(specifier["local"]), source);
        // The exported name decides, however it is renamed locally.
        if (specifier.type === "ImportSpecifier" && specifier["importKind"] !== "type") {
          const imported = nameOf(specifier["imported"]);
          flag(specifier, imported, importedRule(graph, file, source, imported));
        }
      }
    }
    if (
      statement.type === "ExportNamedDeclaration" &&
      source !== "" &&
      statement["exportKind"] !== "type"
    ) {
      for (const specifier of specifiers(statement)) {
        if (specifier.type !== "ExportSpecifier" || specifier["exportKind"] === "type") continue;
        const local = nameOf(specifier["local"]);
        flag(specifier, local, importedRule(graph, file, source, local));
      }
    }
  }
  walk(program, (node) => {
    const property = memberName(node);
    if (property === null) return;
    const object = node["object"];
    if (isNode(object) && object.type === "Identifier" && namespaces.has(nameOf(object)))
      flag(node, property, importedRule(graph, file, namespaces.get(nameOf(object))!, property));
    // A failed result read for its message: `if (!result.ok) … result.error.message`.
    if (property === "message" && memberName(object) === "error") {
      const receiver = (object as SyntaxNode)["object"];
      if (isNode(receiver) && receiver.type === "Identifier" && results.has(nameOf(receiver)))
        found.push({
          file,
          line: node.loc?.start.line ?? 0,
          rule: "message-unwrap",
          name: `${nameOf(receiver)}.error.message`,
        });
    }
  });
  /** `x.message`, `x?.message` or `x["message"]` of an error the guard proved. */
  const shown = (value: unknown, tested: ReadonlySet<string>): value is SyntaxNode =>
    memberName(value) === "message" &&
    isNode((value as SyntaxNode)["object"]) &&
    ((value as SyntaxNode)["object"] as SyntaxNode).type === "Identifier" &&
    tested.has(nameOf((value as SyntaxNode)["object"]));
  const flagShown = (value: SyntaxNode) =>
    found.push({
      file,
      line: value.loc?.start.line ?? 0,
      rule: "message-fallback",
      name: `${nameOf(value["object"])}.message`,
    });
  // An exception's own text shown with a fallback for anything else:
  // `error instanceof Error ? error.message : "It didn't work."`.
  walk(program, (node) => {
    if (node.type !== "ConditionalExpression") return;
    const alternate = node["alternate"];
    const fallback =
      isNode(alternate) &&
      ((alternate.type === "StringLiteral" && nameOf(alternate) !== "") ||
        alternate.type === "TemplateLiteral" ||
        (alternate.type === "CallExpression" && nameOf(alternate["callee"]) === "String"));
    if (!fallback) return;
    const tested = testedErrors(node["test"]);
    if (tested.size === 0) return;
    walk(node["consequent"] as SyntaxNode, (inner) => {
      if (shown(inner, tested)) flagShown(inner);
    });
  });
  /** What a guarded body hands the screen: a React state setter's argument, or JSX. */
  const scanShown = (body: SyntaxNode, tested: ReadonlySet<string>) =>
    walk(body, (inner) => {
      if (inner.type === "CallExpression") {
        const callee = inner["callee"];
        const name = isNode(callee)
          ? callee.type === "Identifier"
            ? nameOf(callee)
            : (memberName(callee) ?? "")
          : "";
        // A React state setter: what it holds is drawn.
        if (/^set[A-Z]/u.test(name))
          for (const argument of (inner["arguments"] ?? []) as unknown[])
            if (shown(argument, tested)) flagShown(argument);
      }
      if (inner.type === "JSXExpressionContainer" && shown(inner["expression"], tested))
        flagShown(inner["expression"] as SyntaxNode);
    });
  // An exception's own text handed to the screen under a guard:
  // `if (error instanceof Error) setError(error.message)`, `{e instanceof Error && <T>{e.message}</T>}`,
  // or after one that leaves otherwise: `if (!(error instanceof Error)) return; setError(error.message)`.
  walk(program, (node) => {
    const guarded =
      node.type === "IfStatement"
        ? { test: node["test"], body: node["consequent"] }
        : node.type === "LogicalExpression" && node["operator"] === "&&"
          ? { test: node["left"], body: node["right"] }
          : null;
    if (guarded !== null && isNode(guarded.body)) {
      const tested = testedErrors(guarded.test);
      if (tested.size > 0) scanShown(guarded.body, tested);
    }
    const block =
      node.type === "BlockStatement" || node.type === "Program"
        ? (node["body"] as readonly SyntaxNode[])
        : node.type === "SwitchCase"
          ? (node["consequent"] as readonly SyntaxNode[])
          : null;
    block?.forEach((statement, index) => {
      const test = statement["test"];
      if (
        statement.type !== "IfStatement" ||
        statement["alternate"] ||
        !isNode(test) ||
        test.type !== "UnaryExpression" ||
        test["operator"] !== "!" ||
        !exits(statement["consequent"])
      )
        return;
      const tested = testedErrors(test["argument"]);
      if (tested.size > 0) for (const after of block.slice(index + 1)) scanShown(after, tested);
    });
  });
  return found;
}

/** Whether a module's text could hold any of these names or patterns; parsing is the costly part. */
function mentions(text: string, names: Iterable<string>): boolean {
  for (const name of names) if (text.includes(name)) return true;
  return false;
}

/** A module the raw-text rules could find something in: an exception or result read for words. */
const mayReadMessage = (text: string) =>
  text.includes("message") && /instanceof|\bok\b/u.test(text);

/**
 * The violations among these UI modules. Parsing is the costly part, so only
 * modules that could re-export a forbidden name, or break a rule, are parsed;
 * each new alias widens the search until none is found.
 */
function scan(
  texts: readonly { readonly file: string; readonly text: string }[],
  exists: (file: string) => boolean,
): Violation[] {
  const uiFiles = new Set(texts.map(({ file }) => file));
  const resolve = (from: string, source: string): string | null => {
    const base = path.posix.join(path.posix.dirname(from), source);
    const stem = base.replace(/\.(?:js|jsx|ts|tsx)$/u, "");
    for (const candidate of [
      base,
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}/index.ts`,
      `${stem}/index.tsx`,
    ])
      if (uiFiles.has(candidate) || exists(candidate)) return candidate;
    return null;
  };
  const isUiModule = (file: string) => uiFiles.has(file);
  const parsed = new Map<string, Parsed>();
  const parsedText = (file: string, text: string) => {
    let value = parsed.get(file);
    if (!value) parsed.set(file, (value = parse(file, text)));
    return value;
  };
  let names = new Set(originals.keys());
  let exports = new Map<string, Map<string, ImportRule>>();
  for (let size = -1; size !== names.size;) {
    size = names.size;
    const exporting = texts
      .filter(
        ({ text }) =>
          /export\s*\*/u.test(text) || (text.includes("export") && mentions(text, names)),
      )
      .map(({ file, text }) => parsedText(file, text));
    exports = exportsOf(exporting, { isUiModule, resolve });
    names = new Set([...names, ...[...exports.values()].flatMap((map) => [...map.keys()])]);
  }
  const graph: ModuleGraph = { exports, isUiModule, resolve };
  const under = (file: string, list: typeof boundaryModules) =>
    list.some((entry) => file === entry.prefix || file.startsWith(entry.prefix));
  return texts
    .filter(
      ({ file, text }) =>
        !under(file, boundaryModules) && (mentions(text, names) || mayReadMessage(text)),
    )
    .flatMap(({ file, text }) =>
      violationsIn(parsedText(file, text), graph, under(file, shellAdapters)),
    );
}

function boundaryViolations(): Violation[] {
  return scan(
    uiModules().map((file) => ({
      file,
      text: readFileSync(path.join(repositoryRoot, file), "utf8"),
    })),
    (file) => existsSync(path.join(repositoryRoot, file)),
  );
}

/** Checks in-memory modules as the repository scan would; `screen.tsx` unless named. */
function check(modules: Readonly<Record<string, string>>, others: readonly string[] = []) {
  return scan(
    Object.entries(modules).map(([file, text]) => ({ file, text })),
    (file) => others.includes(file),
  ).map(({ file, rule, name }) => `${file === "screen.tsx" ? "" : `${file} `}${rule} ${name}`);
}

describe("client feedback boundary", () => {
  it("keeps raw failures and the connection's own words out of screens", () => {
    const violations = boundaryViolations().map(
      ({ file, line, name, rule }) => `${file}:${line} ${rule} ${name}`,
    );
    expect(violations).toEqual([]);
  });

  it("finds forbidden names however they are imported", () => {
    expect(
      check({
        "screen.tsx": [
          'import { presentActionFailure } from "@opensteer/client/feedback";',
          'import { presentActionFailure as say } from "@opensteer/client/feedback";',
          'import { HostClientRequestError as Refusal } from "@opensteer/client/host";',
          'import { connectionNotice } from "@opensteer/client/connections";',
          'import * as feedback from "@opensteer/client/feedback";',
          "feedback.presentActionFailure(error);",
          'feedback["clientPublicDetail"](error);',
          'export { safeMessage as words } from "@opensteer/shared/safeMessage";',
          "if (!result.ok) setError(result.error.message);",
          'if (!reply.ok) setError(reply.error?.["message"]);',
          'setError(failure instanceof Error ? failure.message : "Couldn\'t rename it.");',
          "const words = reason instanceof Error && reason.message ? reason.message : `No.`;",
          'import { presentConnectionGate } from "@opensteer/client/feedback";',
          'import { presentConnectionStarting as starting } from "@opensteer/client/feedback";',
          'import { failureNotice as notice, operationFailure } from "@opensteer/client/host";',
          "try { load(); } catch (error) { if (error instanceof Error) setError(error.message); }",
          "const view = <p>{thrown instanceof Error && <b>{thrown.message}</b>}</p>;",
          "function show(cause: unknown) {",
          "  if (!(cause instanceof Error)) return;",
          "  setStatus(cause.message);",
          "}",
        ].join("\n"),
      }),
    ).toEqual([
      "raw-presenter presentActionFailure",
      "raw-presenter presentActionFailure",
      "transport-error HostClientRequestError",
      "connection-notice connectionNotice",
      "raw-presenter safeMessage",
      "connection-notice presentConnectionGate",
      "connection-notice presentConnectionStarting",
      "raw-presenter failureNotice",
      "raw-presenter operationFailure",
      "raw-presenter presentActionFailure",
      "raw-presenter clientPublicDetail",
      "message-unwrap result.error.message",
      "message-unwrap reply.error.message",
      "message-fallback failure.message",
      "message-fallback reason.message",
      "message-fallback error.message",
      "message-fallback thrown.message",
      "message-fallback cause.message",
    ]);
  });

  it("lets presenters, types and unrelated messages through", () => {
    expect(
      check(
        {
          "screen.tsx": [
            'import { presentClientIssue, clientIssue } from "@opensteer/client/feedback";',
            'import type { HostClientRequestError } from "@opensteer/client/host";',
            'import { type ClientOperationError, useClientConnection } from "@opensteer/client/react";',
            'import { presentActionFailureCopy } from "./elsewhere.js";',
            // A screen's own helper that happens to share a forbidden name.
            'import { safeMessage } from "./words.js";',
            'import { safeMessage as quiet } from "some-library";',
            "const text = message.message;",
            "const words = error.reason;",
            "const failed = run.error.message;",
            // A reason code parsed out of a message is not text shown to anyone.
            'const code = error instanceof Error ? error.message : "";',
            "const detail = dev && error instanceof Error ? error.message : null;",
            'const said = other instanceof Error ? error.message : "Couldn\'t.";',
            // Logged or rethrown under a guard, an exception's text is not drawn.
            "if (error instanceof Error) console.warn(error.message);",
            "if (error instanceof Error) throw new Error(error.message);",
            "if (error instanceof Error) setError(other.message);",
            // A guard that doesn't leave proves nothing about what follows it.
            "if (!(error instanceof Error)) log(error);",
            "setError(error.message);",
            "// import { presentActionFailure } from '@opensteer/client/feedback';",
          ].join("\n"),
          "words.ts": "export function safeMessage(value: string) { return value.trim(); }",
        },
        ["elsewhere.ts"],
      ),
    ).toEqual([]);
  });

  it("follows a forbidden name through every module that renames it, and only those", () => {
    expect(
      check({
        "ui-utils.ts":
          'export { presentActionFailure as actionErrorMessage } from "@opensteer/client/feedback";',
        // A second barrel names only the first one's alias.
        "barrel.ts": 'export { actionErrorMessage as words } from "./ui-utils.js";',
        "stars.ts": 'export * from "./barrel.js";',
        "local.ts": [
          'import { actionErrorMessage } from "./ui-utils.js";',
          "export { actionErrorMessage as again };",
        ].join("\n"),
        "unrelated.ts": "export const words = 1;",
        "screen.tsx": [
          'import { actionErrorMessage as say } from "./ui-utils.js";',
          'import { words } from "./barrel.js";',
          'import { words as starred } from "./stars.js";',
          'import { again } from "./local.js";',
          'import { words as count } from "./unrelated.js";',
        ].join("\n"),
      }),
    ).toEqual([
      "ui-utils.ts raw-presenter presentActionFailure",
      "barrel.ts raw-presenter actionErrorMessage",
      "local.ts raw-presenter actionErrorMessage",
      "raw-presenter actionErrorMessage",
      "raw-presenter words",
      "raw-presenter words",
      "raw-presenter again",
    ]);
    // Where a name is allowed, the allowance holds only for the notice rule it was given for.
    const shell = "apps/web/src/components/connection-shell.tsx";
    expect(
      check({
        [shell]: [
          'import { connectionNotice } from "@opensteer/client/connections";',
          'import { safeMessage } from "@opensteer/shared/safeMessage";',
        ].join("\n"),
      }),
    ).toEqual([`${shell} raw-presenter safeMessage`]);
  });
});
