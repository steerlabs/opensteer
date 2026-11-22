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
const sending = new Set(["evaluate", "evaluateHandle", "waitForFunction", "addInitScript"]);

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

describe("where the first-run journey keeps what it hands over", () => {
  it("hands over only named functions, never one written inline", () => {
    const directory = path.join(repositoryRoot, "tests/first-run");
    const inline: string[] = [];
    for (const file of readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    )) {
      const source = readFileSync(path.join(directory, file), "utf8");
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(visit);
        if (typeof node !== "object" || node === null) return;
        const call = node as {
          type?: string;
          callee?: { type?: string; property?: { name?: string } };
          arguments?: { type: string; loc?: { start: { line: number } } }[];
        };
        if (
          call.type === "CallExpression" &&
          call.callee?.type === "MemberExpression" &&
          sending.has(call.callee.property?.name ?? "")
        ) {
          const first = call.arguments?.[0];
          if (first !== undefined && first.type !== "Identifier")
            inline.push(`${file}:${first.loc?.start.line}: ${call.callee.property?.name}`);
        }
        for (const [key, value] of Object.entries(node))
          if (key !== "loc" && typeof value === "object") visit(value);
      };
      visit(parse(source, { plugins: ["typescript"], sourceType: "module" }).program);
    }
    expect(inline).toEqual([]);
  });
});
