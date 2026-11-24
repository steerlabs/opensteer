import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DeploymentConnectionStatusSchema,
  DesktopDeploymentSummarySchema,
  DesktopPersonalAccountLinkStatusSchema,
  DesktopPersonalDeploymentStatusSchema,
} from "../../packages/protocol/src/desktop.js";

/*
 * Every function the first-run journey hands to another process (`remote.ts`, and the first
 * screen's reader) arrives there as source text. Here each is compiled by the loader the VM runs
 * the journey with (`pnpm exec tsx` from apps/desktop, `journey-command.sh`), taken exactly as
 * Playwright would send it, and run in a bare context holding only what its process gives it:
 * its arguments, and the page's `document` and `window` or the main process's `console`. A
 * reference to anything else (the loader's `__name`, an import, a variable around it) fails here,
 * by the function's name, instead of in the VM twenty minutes in.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function sources(): Record<string, string> {
  const result = spawnSync(
    path.join(repositoryRoot, "node_modules/.bin/tsx"),
    [path.join(repositoryRoot, "tests/first-run/remote-sources.ts")],
    { cwd: path.join(repositoryRoot, "apps/desktop"), encoding: "utf8", timeout: 60_000 },
  );
  if (result.status !== 0) throw new Error(`tsx failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, string>;
}

const snapshot = {
  deployments: [{ onThisComputer: true, status: "connected" }],
  personalAccountLink: { status: "linked" },
  personalSetup: { state: "ready" },
};

/** The page as these functions read it: a setup step's title, and the body's text. */
function page(): Record<string, unknown> {
  return {
    document: {
      body: { innerText: "Connect your phone" },
      querySelector: () => ({ textContent: " Your AI " }),
      querySelectorAll: () => [],
    },
    window: { opensteerDesktop: { getDeploymentAccessSnapshot: async () => snapshot } },
  };
}

/** Electron's main process as these functions read it, and what they did there. */
function main() {
  const done: unknown[][] = [];
  const electron = {
    app: {
      emit: (...args: unknown[]) => {
        done.push(["emit", ...args]);
        return true;
      },
      quit: () => done.push(["quit"]),
    },
    shell: { openExternal: null as unknown },
  };
  const logged: string[] = [];
  return {
    done,
    electron,
    globals: { console: { log: (line: string) => logged.push(line) } },
    logged,
  };
}

/** How each function is run: where, with which arguments, and what it must have done. */
const cases: Record<
  string,
  () => {
    globals: Record<string, unknown>;
    args: unknown[];
    check: (result: unknown) => Promise<void> | void;
  }
> = {
  firstScreenOf: () => ({
    args: [{ connectExisting: "c", keychainTitle: "k", signIn: "s", welcomeTitle: "w" }],
    check: (result) => expect(result).toBeNull(),
    globals: page(),
  }),
  accountLinkStatus: () => ({
    args: [],
    check: (result) => expect(result).toBe("linked"),
    globals: page(),
  }),
  homeIsReady: () => ({ args: [], check: (result) => expect(result).toBe(true), globals: page() }),
  nextKnownSetupStep: () => ({
    args: [{ known: ["Your AI"], previous: null }],
    check: (result) => expect(result).toBe("Your AI"),
    globals: page(),
  }),
  phoneStepSettled: () => ({
    args: ["Connect your phone"],
    check: (result) => expect(result).toBe(true),
    globals: page(),
  }),
  installOpenedMarker: () => {
    const electronMain = main();
    return {
      args: [electronMain.electron, "opened "],
      check: async () => {
        await (electronMain.electron.shell.openExternal as (url: string) => Promise<void>)(
          "https://example.test/",
        );
        expect(electronMain.logged).toEqual(["opened https://example.test/"]);
      },
      globals: electronMain.globals,
    };
  },
  emitOpenUrl: () => {
    const electronMain = main();
    return {
      args: [electronMain.electron, "opensteer://callback"],
      check: () => {
        expect(electronMain.done).toHaveLength(1);
        const [name, event, payload, url] = electronMain.done[0]!;
        expect([name, event, url]).toEqual(["emit", "open-url", "opensteer://callback"]);
        // The event's preventDefault is called by the app's handler: it must run there too.
        (payload as { preventDefault: () => void }).preventDefault();
      },
      globals: electronMain.globals,
    };
  },
  quitApp: () => {
    const electronMain = main();
    return {
      args: [electronMain.electron],
      check: () => expect(electronMain.done).toEqual([["quit"]]),
      globals: electronMain.globals,
    };
  },
};

describe("what the first-run journey hands to the app", () => {
  const sent = sources();

  it("is each a function this test knows how to run", () => {
    expect(Object.keys(sent).sort()).toEqual(Object.keys(cases).sort());
  });

  for (const name of Object.keys(cases))
    it(`runs ${name} with nothing but its arguments and its process's globals`, async () => {
      const source = sent[name];
      expect(source, `${name} was not sent`).toBeDefined();
      const run = cases[name]!();
      const context = createContext({ ...run.globals });
      const fn = runInContext(`(${source})`, context, { filename: `${name}.js` }) as (
        ...args: unknown[]
      ) => unknown;
      let result: unknown;
      try {
        result = await fn(...run.args);
      } catch (error) {
        throw new Error(`${name} cannot run where it is sent: ${String(error)}`);
      }
      await run.check(result);
    });
});

/** The calls that send a function's source to another process. */
describe("the app the page functions read", () => {
  it("is the app's own snapshot: every field and value the stand-in gives them exists", () => {
    // What `accountLinkStatus` and `homeIsReady` read, named and valued as the wire has them.
    expect(
      DesktopPersonalAccountLinkStatusSchema.shape.status.parse(
        snapshot.personalAccountLink.status,
      ),
    ).toBe("linked");
    expect(
      DesktopPersonalDeploymentStatusSchema.shape.state.parse(snapshot.personalSetup.state),
    ).toBe("ready");
    expect(DeploymentConnectionStatusSchema.parse(snapshot.deployments[0]!.status)).toBe(
      "connected",
    );
    expect(Object.keys(DesktopDeploymentSummarySchema.shape)).toContain("onThisComputer");
  });
});

/** The calls that send a function's source to another process, and which argument is it. */
const sending: Readonly<Record<string, number>> = {
  $eval: 1,
  $$eval: 1,
  addInitScript: 0,
  evaluate: 0,
  evaluateAll: 0,
  evaluateHandle: 0,
  waitForFunction: 0,
};

/** Where a sent function may come from: the one module, and the first screen's reader. */
function sendable(source: string, imported: string): boolean {
  return (
    source === "./remote.js" ||
    (imported === "firstScreenOf" && source.endsWith("desktop-first-screen.test-support.js"))
  );
}

type Node = { readonly type: string; readonly loc?: { start: { line: number } } } & Record<
  string,
  unknown
>;
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** Every function a journey file sends that is not an import from where sent functions live. */
export function unsentFrom(file: string, source: string): string[] {
  const ast = parse(source, { plugins: ["typescript"], sourceType: "module" });
  const imports = new Map<string, { source: string; imported: string }>();
  for (const statement of ast.program.body)
    if (statement.type === "ImportDeclaration")
      for (const specifier of statement.specifiers)
        if (specifier.type === "ImportSpecifier")
          imports.set(specifier.local.name, {
            imported:
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value,
            source: statement.source.value,
          });
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    // A call that may not happen (`page?.evaluate(f)`, `page.evaluate?.(f)`) sends as one that does.
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const method = memberName(node["callee"] as Node);
      const index = Object.hasOwn(sending, method) ? sending[method] : undefined;
      const sent = index === undefined ? undefined : (node["arguments"] as Node[])[index];
      if (sent !== undefined) {
        const origin = sent.type === "Identifier" ? imports.get(sent["name"] as string) : undefined;
        if (origin === undefined || !sendable(origin.source, origin.imported))
          found.push(`${file}:${sent.loc?.start.line}: ${method}`);
      }
    }
    for (const [key, value] of Object.entries(node))
      if (key !== "loc" && typeof value === "object") visit(value);
  };
  visit(ast.program);
  return found;
}

/** The member a call is made on: `page.evaluate`, `page?.evaluate`, `page["evaluate"]`. */
function memberName(callee: Node): string {
  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") return "";
  const property = callee["property"] as Node;
  if (!callee["computed"])
    return property.type === "Identifier" ? (property["name"] as string) : "";
  if (property.type === "StringLiteral") return property["value"] as string;
  const quasis = property["quasis"] as Node[] | undefined;
  if (property.type === "TemplateLiteral" && quasis?.length === 1)
    return (quasis[0]!["value"] as { cooked: string }).cooked;
  return "";
}

/** The names a pattern binds: `a`, `{ a, b: c }`, `[a, ...b]`, `a = 1`. */
function bound(pattern: Node | null | undefined, into: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      into.add(pattern["name"] as string);
      return;
    case "ObjectPattern":
      for (const property of pattern["properties"] as Node[])
        bound(
          property.type === "RestElement"
            ? (property["argument"] as Node)
            : (property["value"] as Node),
          into,
        );
      return;
    case "ArrayPattern":
      for (const element of pattern["elements"] as (Node | null)[]) bound(element, into);
      return;
    case "AssignmentPattern":
      bound(pattern["left"] as Node, into);
      return;
    case "RestElement":
      bound(pattern["argument"] as Node, into);
      return;
    default:
      return;
  }
}

const functionTypes = new Set([
  "FunctionExpression",
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "ObjectMethod",
  "ClassMethod",
]);

/**
 * The names a function declares for all of itself: its parameters, its own name, and every `var`
 * in its body. A `let`, `const`, class or function declaration belongs to its block (`blockNames`).
 */
function declaredIn(fn: Node): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn["params"] as Node[]) bound(parameter, names);
  if (fn.type === "FunctionExpression" && fn["id"]) bound(fn["id"] as Node, names);
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!isNode(node)) return;
    if (node.type === "VariableDeclaration" && node["kind"] === "var")
      for (const declarator of node["declarations"] as Node[])
        bound(declarator["id"] as Node, names);
    // A nested function's own names are its own.
    if (functionTypes.has(node.type)) return;
    for (const [key, value] of Object.entries(node))
      if (key !== "loc" && typeof value === "object") collect(value);
  };
  collect(fn["body"]);
  return names;
}

/** The names statements declare for the block that holds them: `let`, `const`, class, function. */
function blockNames(statements: readonly Node[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? (statement["declaration"] as Node) : statement;
    if (!declaration) continue;
    if (declaration.type === "VariableDeclaration" && declaration["kind"] !== "var")
      for (const declarator of declaration["declarations"] as Node[])
        bound(declarator["id"] as Node, names);
    if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration")
      bound(declaration["id"] as Node, names);
  }
  return names;
}

/** What a `for` head declares with `let` or `const`, for the loop alone. */
function loopNames(node: Node): Set<string> {
  const head = (node.type === "ForStatement" ? node["init"] : node["left"]) as Node | null;
  return head?.type === "VariableDeclaration" && head["kind"] !== "var"
    ? blockNames([head])
    : new Set();
}

/**
 * Every name a function's source reads that it does not declare, on every path: what it needs
 * from wherever it runs. Property names, object keys and labels are not names it reads.
 */
export function freeNames(source: string): Set<string> {
  const expression = parse(`(${source})`, { sourceType: "module" }).program
    .body[0] as unknown as Node;
  const free = new Set<string>();
  const walk = (node: unknown, scope: readonly Set<string>[]): void => {
    if (Array.isArray(node)) return node.forEach((child) => walk(child, scope));
    if (!isNode(node)) return;
    if (functionTypes.has(node.type)) {
      const inner = [...scope, declaredIn(node)];
      for (const parameter of node["params"] as Node[]) walkPattern(parameter, inner);
      walk(node["body"], inner);
      return;
    }
    switch (node.type) {
      case "BlockStatement":
      case "StaticBlock":
        walk(node["body"], [...scope, blockNames(node["body"] as Node[])]);
        return;
      case "SwitchStatement":
        walk(node["discriminant"], scope);
        walk(node["cases"], [
          ...scope,
          blockNames((node["cases"] as Node[]).flatMap((c) => c["consequent"] as Node[])),
        ]);
        return;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const inner = [...scope, loopNames(node)];
        for (const [key, value] of Object.entries(node))
          if (key !== "loc" && typeof value === "object") walk(value, inner);
        return;
      }
      case "Identifier":
        if (!scope.some((names) => names.has(node["name"] as string)))
          free.add(node["name"] as string);
        return;
      case "MemberExpression":
      case "OptionalMemberExpression":
        walk(node["object"], scope);
        if (node["computed"]) walk(node["property"], scope);
        return;
      case "ObjectProperty":
        if (node["computed"]) walk(node["key"], scope);
        walk(node["value"], scope);
        return;
      case "VariableDeclarator":
        walkPattern(node["id"] as Node, scope);
        walk(node["init"], scope);
        return;
      case "CatchClause":
        walk(node["body"], [
          ...scope,
          (() => {
            const names = new Set<string>();
            bound(node["param"] as Node, names);
            return names;
          })(),
        ]);
        return;
      case "LabeledStatement":
        walk(node["body"], scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      default:
        for (const [key, value] of Object.entries(node))
          if (key !== "loc" && typeof value === "object") walk(value, scope);
    }
  };
  /** A binding pattern reads only its default values and computed keys. */
  const walkPattern = (pattern: Node | null, scope: readonly Set<string>[]): void => {
    if (!pattern) return;
    if (pattern.type === "AssignmentPattern") {
      walkPattern(pattern["left"] as Node, scope);
      walk(pattern["right"], scope);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern["properties"] as Node[]) {
        if (property.type === "RestElement") walkPattern(property["argument"] as Node, scope);
        else {
          if (property["computed"]) walk(property["key"], scope);
          walkPattern(property["value"] as Node, scope);
        }
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const element of pattern["elements"] as (Node | null)[]) walkPattern(element, scope);
    } else if (pattern.type === "RestElement") walkPattern(pattern["argument"] as Node, scope);
  };
  walk((expression as Node)["expression"], []);
  return free;
}

/** What every process gives a function: the language's own globals. */
const languageGlobals = new Set(
  runInContext("Object.getOwnPropertyNames(globalThis)", createContext({})) as string[],
);
/** And what each process adds. */
const processGlobals: Readonly<Record<"page" | "main", readonly string[]>> = {
  main: ["console"],
  page: ["document", "window"],
};
const runsIn: Readonly<Record<string, "page" | "main">> = {
  accountLinkStatus: "page",
  emitOpenUrl: "main",
  firstScreenOf: "page",
  homeIsReady: "page",
  installOpenedMarker: "main",
  nextKnownSetupStep: "page",
  phoneStepSettled: "page",
  quitApp: "main",
};

describe("where the first-run journey keeps what it hands over", () => {
  const journeyFiles = readdirSync(path.join(repositoryRoot, "tests/first-run"), {
    recursive: true,
  })
    .map(String)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

  it("hands over only what it imports from the one module, by every call that sends one", () => {
    const found = journeyFiles.flatMap((file) =>
      unsentFrom(file, readFileSync(path.join(repositoryRoot, "tests/first-run", file), "utf8")),
    );
    expect(found).toEqual([]);
  });

  it("sees a function written inline, a local one, and one sent by $eval", () => {
    const source = `import { homeIsReady } from "./remote.js";
      const local = () => document.title;
      await page.waitForFunction(homeIsReady);
      await page.evaluate(local);
      await page.evaluate(() => 1);
      await page.$eval("h1", (h) => h.textContent);
      await locator.evaluateAll(local);`;
    expect(unsentFrom("journey.ts", source)).toEqual([
      "journey.ts:4: evaluate",
      "journey.ts:5: evaluate",
      "journey.ts:6: $eval",
      "journey.ts:7: evaluateAll",
    ]);
  });

  it("sees a call that may not happen and one by a computed name", () => {
    const source = `const local = () => document.title;
      await page?.evaluate(local);
      await page.evaluate?.(local);
      await page["evaluate"](local);
      await page[\`waitForFunction\`](local);`;
    expect(unsentFrom("journey.ts", source)).toEqual([
      "journey.ts:2: evaluate",
      "journey.ts:3: evaluate",
      "journey.ts:4: evaluate",
      "journey.ts:5: waitForFunction",
    ]);
  });

  const sent = sources();
  it("knows where every function the module sends runs", () => {
    expect(Object.keys(sent).sort()).toEqual(Object.keys(runsIn).sort());
  });
  for (const [name, where] of Object.entries(runsIn))
    it(`reads nothing in ${name}, on any path, that its process does not give it`, () => {
      const allowed = new Set([...languageGlobals, ...processGlobals[where]]);
      expect([...freeNames(sent[name]!)].filter((free) => !allowed.has(free))).toEqual([]);
    });

  it("sees a free name on a path a run would not take", () => {
    const source = `function settled(sentence) {
      const text = document.body.innerText;
      return text.includes(sentence) || __name(/x/u).test(text);
    }`;
    expect([...freeNames(source)].sort()).toEqual(["__name", "document"]);
  });

  it("sees a name read outside the block that declared it", () => {
    const source = `function settled(a) {
      if (a) { const t = 1; let u = t; }
      for (const v of [1]) v;
      try { const w = 1 } catch { }
      return t + u + v + w;
    }`;
    expect([...freeNames(source)].sort()).toEqual(["t", "u", "v", "w"]);
  });

  it("knows a block's names inside it, a var's in all its function, and a function's hoisted", () => {
    const source = `function settled(a) {
      if (a) { var hoisted = 1; const inner = 2; inner; later(); function later() {} }
      for (let index = 0; index < 1; index += 1) index;
      switch (a) { case 1: const chosen = 1; chosen; }
      return hoisted;
    }`;
    expect([...freeNames(source)]).toEqual([]);
  });
});
