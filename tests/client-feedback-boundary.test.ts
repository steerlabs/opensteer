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

/** Every non-test source a person's screen is drawn from. */
function uiModules(): string[] {
  return [
    ...sourcesUnder("apps/web/src"),
    ...sourcesUnder("apps/mobile/src"),
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

const statements = (program: SyntaxNode) => program["body"] as readonly SyntaxNode[];
const specifiers = (node: SyntaxNode) => (node["specifiers"] ?? []) as readonly SyntaxNode[];

/**
 * Names re-exported under another name are the same binding: a module that
 * re-exports a forbidden name forbids its alias too, wherever it is imported.
 */
function aliasesOf(files: readonly Parsed[], names: ReadonlySet<string>): Set<string> {
  const all = new Set(names);
  for (let grew = true; grew;) {
    grew = false;
    for (const { program } of files) {
      for (const statement of statements(program)) {
        if (statement.type !== "ExportNamedDeclaration" || statement["exportKind"] === "type")
          continue;
        for (const specifier of specifiers(statement)) {
          if (specifier.type !== "ExportSpecifier") continue;
          const exported = nameOf(specifier["exported"]);
          if (all.has(nameOf(specifier["local"])) && !all.has(exported)) {
            all.add(exported);
            grew = true;
          }
        }
      }
    }
  }
  return all;
}

/** What one module does that the rules forbid, given the forbidden name sets. */
function violationsIn(
  parsed: Parsed,
  rules: {
    readonly rawPresenters: ReadonlySet<string>;
    readonly transportErrors: ReadonlySet<string>;
    readonly connectionNotices: ReadonlySet<string> | null;
  },
): Violation[] {
  const { file, program } = parsed;
  const found: Violation[] = [];
  const ruleFor = (name: string): Violation["rule"] | null =>
    rules.rawPresenters.has(name)
      ? "raw-presenter"
      : rules.transportErrors.has(name)
        ? "transport-error"
        : rules.connectionNotices?.has(name)
          ? "connection-notice"
          : null;
  const flag = (node: SyntaxNode, name: string) => {
    const rule = ruleFor(name);
    if (rule) found.push({ file, line: node.loc?.start.line ?? 0, rule, name });
  };
  // Namespace imports are read through their members: `feedback.presentActionFailure`.
  const namespaces = new Set<string>();
  // Results branched on `.ok`: an RPC or bridge result, whose failed `.error.message` is raw.
  const results = new Set<string>();
  walk(program, (node) => {
    if (
      (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      !node["computed"] &&
      nameOf(node["property"]) === "ok" &&
      isNode(node["object"]) &&
      node["object"].type === "Identifier"
    )
      results.add(nameOf(node["object"]));
  });
  for (const statement of statements(program)) {
    if (statement.type === "ImportDeclaration" && statement["importKind"] !== "type") {
      for (const specifier of specifiers(statement)) {
        if (specifier.type === "ImportNamespaceSpecifier")
          namespaces.add(nameOf(specifier["local"]));
        // The exported name decides, however it is renamed locally.
        if (specifier.type === "ImportSpecifier" && specifier["importKind"] !== "type")
          flag(specifier, nameOf(specifier["imported"]));
      }
    }
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement["source"] &&
      statement["exportKind"] !== "type"
    ) {
      for (const specifier of specifiers(statement)) {
        if (specifier.type === "ExportSpecifier" && specifier["exportKind"] !== "type")
          flag(specifier, nameOf(specifier["local"]));
      }
    }
  }
  walk(program, (node) => {
    if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return;
    if (node["computed"]) return;
    const object = node["object"];
    const property = nameOf(node["property"]);
    if (isNode(object) && object.type === "Identifier" && namespaces.has(nameOf(object)))
      flag(node, property);
    // A failed result read for its message: `if (!result.ok) … result.error.message`.
    if (
      property === "message" &&
      isNode(object) &&
      (object.type === "MemberExpression" || object.type === "OptionalMemberExpression") &&
      !object["computed"] &&
      nameOf(object["property"]) === "error"
    ) {
      const receiver = object["object"];
      if (isNode(receiver) && receiver.type === "Identifier" && results.has(nameOf(receiver)))
        found.push({
          file,
          line: node.loc?.start.line ?? 0,
          rule: "message-unwrap",
          name: `${nameOf(receiver)}.error.message`,
        });
    }
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
    const tested = new Set<string>();
    walk(node["test"] as SyntaxNode, (inner) => {
      if (
        inner.type === "BinaryExpression" &&
        inner["operator"] === "instanceof" &&
        isNode(inner["left"]) &&
        inner["left"].type === "Identifier" &&
        nameOf(inner["right"]) === "Error"
      )
        tested.add(nameOf(inner["left"]));
    });
    if (tested.size === 0) return;
    walk(node["consequent"] as SyntaxNode, (inner) => {
      const object = inner["object"];
      if (
        (inner.type === "MemberExpression" || inner.type === "OptionalMemberExpression") &&
        nameOf(inner["property"]) === "message" &&
        isNode(object) &&
        object.type === "Identifier" &&
        tested.has(nameOf(object))
      )
        found.push({
          file,
          line: inner.loc?.start.line ?? 0,
          rule: "message-fallback",
          name: `${nameOf(object)}.message`,
        });
    });
  });
  // An exception's own text handed to the screen under a guard:
  // `if (error instanceof Error) setError(error.message)` or `{e instanceof Error && <T>{e.message}</T>}`.
  walk(program, (node) => {
    const guarded =
      node.type === "IfStatement"
        ? { test: node["test"], body: node["consequent"] }
        : node.type === "LogicalExpression" && node["operator"] === "&&"
          ? { test: node["left"], body: node["right"] }
          : null;
    if (guarded === null || !isNode(guarded.test) || !isNode(guarded.body)) return;
    const tested = new Set<string>();
    walk(guarded.test, (inner) => {
      if (
        inner.type === "BinaryExpression" &&
        inner["operator"] === "instanceof" &&
        isNode(inner["left"]) &&
        inner["left"].type === "Identifier" &&
        nameOf(inner["right"]) === "Error"
      )
        tested.add(nameOf(inner["left"]));
    });
    if (tested.size === 0) return;
    const shown = (value: unknown): value is SyntaxNode =>
      isNode(value) &&
      (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") &&
      nameOf(value["property"]) === "message" &&
      isNode(value["object"]) &&
      value["object"].type === "Identifier" &&
      tested.has(nameOf(value["object"]));
    const flagShown = (value: SyntaxNode) =>
      found.push({
        file,
        line: value.loc?.start.line ?? 0,
        rule: "message-fallback",
        name: `${nameOf(value["object"])}.message`,
      });
    walk(guarded.body, (inner) => {
      if (inner.type === "CallExpression") {
        const callee = inner["callee"];
        const name = isNode(callee)
          ? callee.type === "Identifier"
            ? nameOf(callee)
            : nameOf(callee["property"])
          : "";
        // A React state setter: what it holds is drawn.
        if (/^set[A-Z]/u.test(name))
          for (const argument of (inner["arguments"] ?? []) as unknown[])
            if (shown(argument)) flagShown(argument);
      }
      if (inner.type === "JSXExpressionContainer" && shown(inner["expression"]))
        flagShown(inner["expression"] as SyntaxNode);
    });
  });
  return found;
}

/** Whether a module's text could hold any of these names or patterns; parsing is the costly part. */
function mentions(text: string, names: Iterable<string>): boolean {
  for (const name of names) if (text.includes(name)) return true;
  return false;
}

function boundaryViolations(): Violation[] {
  const texts = uiModules().map((file) => ({
    file,
    text: readFileSync(path.join(repositoryRoot, file), "utf8"),
  }));
  const forbidden = [...rawPresenters, ...transportErrors, ...connectionNotices];
  // A module that renames a forbidden name names it too, so aliases are found among these;
  // a namespace import's member access names it as well.
  const exporting = texts
    .filter(({ text }) => text.includes("export") && mentions(text, forbidden))
    .map(({ file, text }) => parse(file, text));
  const presenters = aliasesOf(exporting, rawPresenters);
  const errors = aliasesOf(exporting, transportErrors);
  const notices = aliasesOf(exporting, connectionNotices);
  const patterns = [...presenters, ...errors, ...notices, "instanceof Error", ".error.message"];
  const under = (file: string, list: typeof boundaryModules) =>
    list.some((entry) => file === entry.prefix || file.startsWith(entry.prefix));
  return texts
    .filter(({ file, text }) => !under(file, boundaryModules) && mentions(text, patterns))
    .map(({ file, text }) => parse(file, text))
    .flatMap((parsed) =>
      violationsIn(parsed, {
        rawPresenters: presenters,
        transportErrors: errors,
        connectionNotices: under(parsed.file, shellAdapters) ? null : notices,
      }),
    );
}

describe("client feedback boundary", () => {
  it("keeps raw failures and the connection's own words out of screens", () => {
    const violations = boundaryViolations().map(
      ({ file, line, name, rule }) => `${file}:${line} ${rule} ${name}`,
    );
    expect(violations).toEqual([]);
  });

  it("finds forbidden names however they are imported", () => {
    const rules = { rawPresenters, transportErrors, connectionNotices };
    const check = (text: string, file = "screen.tsx") =>
      violationsIn(parse(file, text), rules).map(({ rule, name }) => `${rule} ${name}`);

    expect(
      check(
        [
          'import { presentActionFailure } from "@opensteer/client/feedback";',
          'import { presentActionFailure as say } from "@opensteer/client/feedback";',
          'import { HostClientRequestError as Refusal } from "@opensteer/client/host";',
          'import { connectionNotice } from "@opensteer/client/connections";',
          'import * as feedback from "@opensteer/client/feedback";',
          "feedback.presentActionFailure(error);",
          'export { safeMessage as words } from "@opensteer/shared/safeMessage";',
          "if (!result.ok) setError(result.error.message);",
          'setError(failure instanceof Error ? failure.message : "Couldn\'t rename it.");',
          "const words = reason instanceof Error && reason.message ? reason.message : `No.`;",
          'import { presentConnectionGate } from "@opensteer/client/feedback";',
          'import { presentConnectionStarting as starting } from "@opensteer/client/feedback";',
          "try { load(); } catch (error) { if (error instanceof Error) setError(error.message); }",
          "const view = <p>{thrown instanceof Error && <b>{thrown.message}</b>}</p>;",
        ].join("\n"),
      ),
    ).toEqual([
      "raw-presenter presentActionFailure",
      "raw-presenter presentActionFailure",
      "transport-error HostClientRequestError",
      "connection-notice connectionNotice",
      "raw-presenter safeMessage",
      "connection-notice presentConnectionGate",
      "connection-notice presentConnectionStarting",
      "raw-presenter presentActionFailure",
      "message-unwrap result.error.message",
      "message-fallback failure.message",
      "message-fallback reason.message",
      "message-fallback error.message",
      "message-fallback thrown.message",
    ]);
  });

  it("lets presenters, types and unrelated messages through", () => {
    const rules = { rawPresenters, transportErrors, connectionNotices };
    const check = (text: string) =>
      violationsIn(parse("screen.tsx", text), rules).map(({ rule, name }) => `${rule} ${name}`);

    expect(
      check(
        [
          'import { presentClientIssue, clientIssue } from "@opensteer/client/feedback";',
          'import type { HostClientRequestError } from "@opensteer/client/host";',
          'import { type ClientOperationError, useClientConnection } from "@opensteer/client/react";',
          'import { presentActionFailureCopy } from "./elsewhere.js";',
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
          "// import { presentActionFailure } from '@opensteer/client/feedback';",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("follows a forbidden name through a module that renames it", () => {
    const files = [
      parse(
        "ui-utils.ts",
        'export { presentActionFailure as actionErrorMessage } from "@opensteer/client/feedback";',
      ),
      parse("screen.tsx", 'import { actionErrorMessage as say } from "./ui-utils.js";'),
    ];
    const aliases = aliasesOf(files, rawPresenters);
    expect(
      violationsIn(files[1]!, {
        rawPresenters: aliases,
        transportErrors,
        connectionNotices,
      }).map(({ rule, name }) => `${rule} ${name}`),
    ).toEqual(["raw-presenter actionErrorMessage"]);
    // Where a name is allowed, the allowance holds only for the notice rule it was given for.
    expect(
      violationsIn(parse("shell.tsx", 'import { connectionNotice } from "x";'), {
        rawPresenters,
        transportErrors,
        connectionNotices: null,
      }),
    ).toEqual([]);
  });
});
