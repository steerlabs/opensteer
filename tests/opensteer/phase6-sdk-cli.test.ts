import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { BrowserCoreEngine } from "../../packages/browser-core/src/index.js";
import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import type {
  OpensteerPageSnapshotOutput,
  OpensteerSnapshotCounter,
} from "../../packages/protocol/src/index.js";
import {
  Opensteer,
  OpensteerSessionRuntime,
  createDomRuntime,
  createFilesystemOpensteerRoot,
  defaultPolicy,
  type OpensteerPolicy,
} from "../../packages/opensteer/src/index.js";
import { ensureOpensteerService } from "../../packages/opensteer/src/cli/client.js";
import {
  cleanupPhase6TemporaryRoots,
  createPhase6TemporaryRoot,
  startPhase6FixtureServer,
  type Phase6FixtureServer,
} from "./phase6-fixture.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

let fixtureServer: Phase6FixtureServer | undefined;

beforeAll(async () => {
  fixtureServer = await startPhase6FixtureServer();
  if (!(await hasBuiltCliArtifacts())) {
    await execFile("pnpm", ["build"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 4,
    });
  }
}, 120_000);

afterEach(async () => {
  await cleanupPhase6TemporaryRoots();
});

afterAll(async () => {
  await fixtureServer?.close();
});

describe("Phase 6 SDK and CLI surfaces", () => {
  test("SDK composes snapshot, action persistence, extraction replay, traces, and artifacts", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase6-sdk",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      const state = await opensteer.open(`${baseUrl}/phase6/main`);
      expect(state.url).toBe(`${baseUrl}/phase6/main`);

      const actionSnapshot = await opensteer.snapshot("action");
      expect(actionSnapshot.html).toContain("<os-iframe-root");
      expect(actionSnapshot.html).toContain("<os-shadow-root");

      const mainAction = requireCounter(actionSnapshot, (counter) =>
        counter.pathHint.includes("#main-action"),
      );
      const hoverTarget = requireCounter(actionSnapshot, (counter) =>
        counter.pathHint.includes("#hover-target"),
      );
      const rewriteButton = requireCounter(actionSnapshot, (counter) =>
        counter.pathHint.includes("#rewrite"),
      );
      const descriptorButton = requireCounter(actionSnapshot, (counter) =>
        counter.pathHint.includes("#descriptor-button"),
      );
      const scrollAnchor = requireCounter(actionSnapshot, (counter) =>
        counter.pathHint.includes("#scroll-anchor"),
      );
      const mainInput = requireCounter(actionSnapshot, (counter) =>
        counter.pathHint.includes("#main-input"),
      );

      await opensteer.click({
        element: mainAction.element,
        description: "main action button",
      });
      expect(
        await opensteer.extract({
          description: "status text",
          schema: {
            status: { selector: "#status" },
          },
        }),
      ).toEqual({
        status: "main clicked",
      });

      await opensteer.hover({
        element: hoverTarget.element,
      });
      expect(await opensteer.extract({ description: "status text" })).toEqual({
        status: "hovered",
      });

      await opensteer.input({
        element: mainInput.element,
        text: "phase6",
        description: "main input field",
      });
      expect(
        await opensteer.extract({
          description: "mirror text",
          schema: {
            mirror: { selector: "#mirror" },
          },
        }),
      ).toEqual({
        mirror: "phase6",
      });

      await opensteer.click({
        element: descriptorButton.element,
        description: "descriptor button",
      });
      expect(await opensteer.extract({ description: "status text" })).toEqual({
        status: "descriptor clicked v1",
      });

      await opensteer.scroll({
        element: scrollAnchor.element,
        direction: "down",
        amount: 200,
      });
      const scrolled = (await opensteer.extract({ description: "status text" })) as {
        readonly status: string;
      };
      expect(scrolled.status.startsWith("scrolled ")).toBe(true);

      await opensteer.click({
        element: rewriteButton.element,
      });
      await opensteer.click({
        description: "descriptor button",
      });
      expect(await opensteer.extract({ description: "status text" })).toEqual({
        status: "descriptor clicked v2",
      });

      const extractionSnapshot = await opensteer.snapshot("extraction");
      const childLink = requireCounter(extractionSnapshot, (counter) =>
        counter.pathHint.includes("#child-link"),
      );
      const childImage = requireCounter(extractionSnapshot, (counter) =>
        counter.pathHint.includes("#child-image"),
      );

      const extracted = await opensteer.extract({
        description: "child content",
        schema: {
          currentUrl: { source: "current_url" },
          childLink: { element: childLink.element, attribute: "href" },
          imageUrl: { element: childImage.element, attribute: "srcset" },
          items: [
            {
              title: { selector: "#child-list li:nth-child(1) a.title" },
              url: { selector: "#child-list li:nth-child(1) a.title", attribute: "href" },
              price: { selector: "#child-list li:nth-child(1) .price" },
            },
            {
              title: { selector: "#child-list li:nth-child(2) a.title" },
              url: { selector: "#child-list li:nth-child(2) a.title", attribute: "href" },
              price: { selector: "#child-list li:nth-child(2) .price" },
            },
          ],
        },
      });

      expect(extracted).toEqual({
        currentUrl: `${baseUrl}/phase6/main`,
        childLink: `${baseUrl}/child-relative`,
        imageUrl: `${baseUrl}/large.png`,
        items: [
          { title: "One", url: `${baseUrl}/item-1`, price: "$1" },
          { title: "Two", url: `${baseUrl}/item-2`, price: "$2" },
        ],
      });
      expect(await opensteer.extract({ description: "child content" })).toEqual(extracted);

      const artifactManifests = await readdir(
        path.join(rootDir, ".opensteer", "artifacts", "manifests"),
      );
      const traceRuns = await readdir(path.join(rootDir, ".opensteer", "traces", "runs"));
      expect(artifactManifests.length).toBeGreaterThan(0);
      expect(traceRuns.length).toBeGreaterThan(0);
    } finally {
      await opensteer.close();
    }
  }, 60_000);

  test("SDK resolves stale counters session-locally and promotes the recovered live node on description writes", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const opensteer = new Opensteer({
      name: "phase6-stale-counter",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open(
        htmlDataUrl(
          `
            <button id="swap" type="button">Swap</button>
            <div id="slot">
              <button id="target" type="button">Target V1</button>
            </div>
            <div id="status">ready</div>
            <script>
              const status = document.getElementById("status");
              const wire = (label) => {
                document.getElementById("target").addEventListener("click", () => {
                  status.textContent = "clicked " + label;
                });
              };
              wire("v1");
              document.getElementById("swap").addEventListener("click", () => {
                document.getElementById("slot").innerHTML =
                  '<button id="target" type="button">Target V2</button>';
                wire("v2");
                status.textContent = "swapped";
              });
            </script>
          `,
          "Phase 6 stale counter",
        ),
      );

      const snapshot = await opensteer.snapshot("action");
      const swapButton = requireCounter(snapshot, (counter) => counter.pathHint.includes("#swap"));
      const targetButton = requireCounter(snapshot, (counter) => counter.pathHint.includes("#target"));

      await opensteer.click({
        element: swapButton.element,
      });
      await opensteer.click({
        element: targetButton.element,
      });

      expect(
        await opensteer.extract({
          schema: {
            status: { selector: "#status" },
          },
          description: "stale counter status",
        }),
      ).toEqual({
        status: "clicked v2",
      });

      await opensteer.click({
        element: targetButton.element,
        description: "swapped target button",
      });
      await opensteer.click({
        description: "swapped target button",
      });

      expect(await opensteer.extract({ description: "stale counter status" })).toEqual({
        status: "clicked v2",
      });
    } finally {
      await opensteer.close();
    }
  }, 60_000);

  test("SDK extraction authoring fails cleanly when a counter can no longer be promoted", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const opensteer = new Opensteer({
      name: "phase6-extract-drift",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open(
        htmlDataUrl(
          `
            <button id="drift" type="button">Drift</button>
            <div id="slot">
              <button class="choice" type="button">Only choice</button>
            </div>
            <script>
              document.getElementById("drift").addEventListener("click", () => {
                document.getElementById("slot").innerHTML =
                  '<div class="wrapper"><button class="choice" type="button">Wrapped choice</button></div>';
              });
            </script>
          `,
          "Phase 6 extraction drift",
        ),
      );

      const snapshot = await opensteer.snapshot("extraction");
      const choice = requireCounter(snapshot, (counter) => counter.pathHint.includes(".choice"));

      await opensteer.click({
        selector: "#drift",
      });

      await expect(
        opensteer.extract({
          description: "drifted choice",
          schema: {
            value: { element: choice.element },
          },
        }),
      ).rejects.toThrow(/structural anchor|stale|not found|unable/i);
    } finally {
      await opensteer.close();
    }
  }, 60_000);

  test("CLI preserves browser continuity across processes and tears down the session service on close", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const sessionName = "phase6-cli";

    const opened = await runCliCommand(rootDir, [
      "open",
      `${baseUrl}/phase6/main`,
      "--name",
      sessionName,
      "--headless",
      "true",
    ]);
    expect(opened.url).toBe(`${baseUrl}/phase6/main`);

    const snapshot = await runCliCommand(rootDir, ["snapshot", "action", "--name", sessionName]);
    const descriptorButton = requireCounter(snapshot as OpensteerPageSnapshotOutput, (counter) =>
      counter.pathHint.includes("#descriptor-button"),
    );
    const rewriteButton = requireCounter(snapshot as OpensteerPageSnapshotOutput, (counter) =>
      counter.pathHint.includes("#rewrite"),
    );

    await runCliCommand(rootDir, [
      "click",
      String(descriptorButton.element),
      "--name",
      sessionName,
      "--description",
      "descriptor button",
    ]);
    await runCliCommand(rootDir, ["click", String(rewriteButton.element), "--name", sessionName]);
    await runCliCommand(rootDir, [
      "click",
      "--name",
      sessionName,
      "--description",
      "descriptor button",
    ]);

    const extracted = await runCliCommand(rootDir, [
      "extract",
      '{"status":{"selector":"#status"}}',
      "--name",
      sessionName,
      "--description",
      "status text",
    ]);
    expect(extracted).toEqual({
      status: "descriptor clicked v2",
    });

    const replayed = await runCliCommand(rootDir, [
      "extract",
      "--name",
      sessionName,
      "--description",
      "status text",
    ]);
    expect(replayed).toEqual({
      status: "descriptor clicked v2",
    });

    const closed = await runCliCommand(rootDir, ["close", "--name", sessionName]);
    expect(closed).toEqual({
      closed: true,
    });

    const metadataPath = path.join(
      rootDir,
      ".opensteer",
      "runtime",
      "sessions",
      encodeURIComponent(sessionName),
      "service.json",
    );
    expect((await readdir(path.dirname(metadataPath))).includes("service.json")).toBe(false);
  }, 60_000);

  test("CLI forwards raw computer-use actions through the local service boundary", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const sessionName = "phase9-cli-computer";

    await runCliCommand(rootDir, [
      "open",
      `${baseUrl}/phase6/main`,
      "--name",
      sessionName,
      "--headless",
      "true",
    ]);

    const computer = await runCliCommand(rootDir, [
      "computer",
      '{"type":"click","x":110,"y":41}',
      "--name",
      sessionName,
      "--annotations",
      "clickable,grid",
    ]);
    expect((computer as { readonly action: { readonly type: string } }).action.type).toBe("click");

    const extracted = await runCliCommand(rootDir, [
      "extract",
      '{"status":{"selector":"#status"}}',
      "--name",
      sessionName,
      "--description",
      "status text",
    ]);
    expect(extracted).toEqual({
      status: "main clicked",
    });

    await runCliCommand(rootDir, ["close", "--name", sessionName]);
  }, 60_000);

  test("SDK rejects invalid semantic input at the runtime boundary", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase6-invalid-runtime",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/phase6/main`);
      const opensteerJs = opensteer as unknown as {
        snapshot(input: unknown): Promise<unknown>;
      };
      await expect(opensteerJs.snapshot("bogus")).rejects.toMatchObject({
        code: "invalid-request",
      });
    } finally {
      await opensteer.close();
    }
  });

  test("session.open and page.goto use policy-governed navigation settle", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const runtime = new OpensteerSessionRuntime({
      name: "phase7-navigation-settle",
      rootDir,
      browser: {
        headless: true,
      },
      policy: createPolicy({
        navigationSettleMs: 120,
      }),
    });

    try {
      const opened = await runtime.open({
        url: delayedTitleUrl("open pending", "open settled", 60),
      });
      expect(opened.title).toBe("open settled");

      const navigated = await runtime.goto({
        url: delayedTitleUrl("goto pending", "goto settled", 60),
      });
      expect(navigated.title).toBe("goto settled");
    } finally {
      await runtime.close().catch(() => undefined);
    }
  }, 60_000);

  test("policy injection overrides settle behavior for OpensteerSessionRuntime and Opensteer", async () => {
    const runtimeRootDir = await createPhase6TemporaryRoot();
    const runtime = new OpensteerSessionRuntime({
      name: "phase7-runtime-policy-override",
      rootDir: runtimeRootDir,
      browser: {
        headless: true,
      },
      policy: createPolicy({
        navigationSettleMs: 0,
      }),
    });

    const opensteerRootDir = await createPhase6TemporaryRoot();
    const opensteer = new Opensteer({
      name: "phase7-opensteer-policy-override",
      rootDir: opensteerRootDir,
      browser: {
        headless: true,
      },
      policy: createPolicy({
        navigationSettleMs: 0,
      }),
    });

    try {
      const runtimeState = await runtime.open({
        url: delayedTitleUrl("runtime pending", "runtime settled", 60),
      });
      expect(runtimeState.title).toBe("runtime pending");

      const opensteerState = await opensteer.open(
        delayedTitleUrl("opensteer pending", "opensteer settled", 60),
      );
      expect(opensteerState.title).toBe("opensteer pending");
    } finally {
      await runtime.close().catch(() => undefined);
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("snapshot and extract respect timeout policy", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const engine = await createDelayedPlaywrightEngine(25);
    const runtime = new OpensteerSessionRuntime({
      name: "phase7-timeout-policy",
      rootDir,
      engine,
      policy: createPolicy({
        operationTimeouts: {
          "page.snapshot": 1,
          "dom.extract": 1,
        },
      }),
    });

    try {
      await runtime.open({
        url: `${baseUrl}/phase6/main`,
      });

      await expect(
        runtime.snapshot({
          mode: "action",
        }),
      ).rejects.toMatchObject({
        code: "timeout",
        details: {
          policy: "timeout",
          operation: "page.snapshot",
        },
      });

      await expect(
        runtime.extract({
          description: "status text",
          schema: {
            status: { selector: "#status" },
          },
        }),
      ).rejects.toMatchObject({
        code: "timeout",
        details: {
          policy: "timeout",
          operation: "dom.extract",
        },
      });
    } finally {
      await runtime.close().catch(() => undefined);
      await engine.dispose?.();
    }
  }, 60_000);

  test("dom action timeouts cover SDK target preparation and do not persist late descriptors", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const engine = await createDelayedPlaywrightEngine(25);
    const runtime = new OpensteerSessionRuntime({
      name: "phase7-dom-action-timeout",
      rootDir,
      engine,
      policy: createPolicy({
        operationTimeouts: {
          "dom.click": 1,
        },
      }),
    });

    try {
      await runtime.open({
        url: `${baseUrl}/phase6/main`,
      });

      await expect(
        runtime.click({
          target: {
            kind: "selector",
            selector: "#main-action",
          },
          persistAsDescription: "slow action button",
        }),
      ).rejects.toMatchObject({
        code: "timeout",
        details: {
          policy: "timeout",
          operation: "dom.click",
        },
      });

      await wait(80);
      const root = await createFilesystemOpensteerRoot({
        rootPath: path.join(rootDir, ".opensteer"),
      });
      const dom = createDomRuntime({
        engine,
        root,
        namespace: "phase7-dom-action-timeout",
      });
      await expect(
        dom.readDescriptor({
          description: "slow action button",
        }),
      ).resolves.toBeUndefined();

      await expect(
        runtime.extract({
          description: "status text",
          schema: {
            status: { selector: "#status" },
          },
        }),
      ).resolves.toEqual({
        data: {
          status: "ready",
        },
      });
    } finally {
      await runtime.close().catch(() => undefined);
      await engine.dispose?.();
    }
  }, 60_000);

  test("service returns invalid-request for invalid payloads and not-found for missing descriptors", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const sessionName = "phase6-service-validation";
    const client = await ensureOpensteerService({
      name: sessionName,
      rootDir,
      launchContext: {
        execPath: process.execPath,
        execArgv: process.execArgv,
        scriptPath: CLI_SCRIPT,
        cwd: process.cwd(),
      },
    });

    try {
      await client.invoke("session.open", {
        url: `${baseUrl}/phase6/main`,
        name: sessionName,
        browser: { headless: true },
      });

      await expect(
        client.invoke("page.snapshot", {
          mode: "bogus",
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        opensteerError: {
          code: "invalid-request",
        },
      });

      await expect(
        client.invoke("dom.extract", {
          description: "missing extraction descriptor",
        }),
      ).rejects.toMatchObject({
        statusCode: 404,
        opensteerError: {
          code: "not-found",
        },
      });

      await expect(
        client.invoke("dom.click", {
          target: {
            kind: "description",
            description: "missing dom descriptor",
          },
        }),
      ).rejects.toMatchObject({
        statusCode: 404,
        opensteerError: {
          code: "not-found",
        },
      });
    } finally {
      await client.invoke("session.close", {}).catch(() => undefined);
    }
  }, 60_000);
});

function requireFixtureServer(): Phase6FixtureServer {
  if (!fixtureServer) {
    throw new Error("phase 6 fixture server is not running");
  }
  return fixtureServer;
}

function requireCounter(
  snapshot: OpensteerPageSnapshotOutput,
  predicate: (counter: OpensteerSnapshotCounter) => boolean,
): OpensteerSnapshotCounter {
  const match = snapshot.counters.find(predicate);
  if (!match) {
    throw new Error("failed to find expected snapshot counter");
  }
  return match;
}

async function runCliCommand(rootDir: string, args: readonly string[]): Promise<unknown> {
  const { stdout, stderr } = await execFile(process.execPath, [CLI_SCRIPT, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
    },
    maxBuffer: 1024 * 1024,
  });

  expect(stderr.trim()).toBe("");
  return JSON.parse(stdout.trim()) as unknown;
}

async function hasBuiltCliArtifacts(): Promise<boolean> {
  const requiredPaths = [
    CLI_SCRIPT,
    path.resolve(process.cwd(), "packages/protocol/dist/index.js"),
    path.resolve(process.cwd(), "packages/opensteer/dist/index.js"),
  ];

  try {
    await Promise.all(requiredPaths.map((filePath) => access(filePath)));
    return true;
  } catch {
    return false;
  }
}

function createPolicy(options: {
  readonly navigationSettleMs?: number;
  readonly domActionSettleMs?: number;
  readonly operationTimeouts?: Readonly<
    Partial<
      Record<
        | "session.open"
        | "page.goto"
        | "page.snapshot"
        | "dom.click"
        | "dom.hover"
        | "dom.input"
        | "dom.scroll"
        | "dom.extract"
        | "session.close",
        number
      >
    >
  >;
}): OpensteerPolicy {
  const base = defaultPolicy();
  return {
    ...base,
    settle: {
      observers: [],
      resolveDelayMs(input) {
        if (input.trigger === "navigation" && options.navigationSettleMs !== undefined) {
          return options.navigationSettleMs;
        }
        if (input.trigger === "dom-action" && options.domActionSettleMs !== undefined) {
          return options.domActionSettleMs;
        }
        return base.settle.resolveDelayMs(input);
      },
    },
    timeout: {
      resolveTimeoutMs(input) {
        return options.operationTimeouts?.[input.operation] ?? base.timeout.resolveTimeoutMs(input);
      },
    },
  };
}

function delayedTitleUrl(initialTitle: string, settledTitle: string, delayMs: number): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${initialTitle}</title>
  </head>
  <body>
    <div id="status">${initialTitle}</div>
    <script>
      setTimeout(() => {
        document.title = ${JSON.stringify(settledTitle)};
        document.getElementById("status").textContent = ${JSON.stringify(settledTitle)};
      }, ${String(delayMs)});
    </script>
  </body>
</html>`)}`;
}

function htmlDataUrl(body: string, title: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
  </head>
  <body>${body}</body>
</html>`)}`;
}

async function createDelayedPlaywrightEngine(delayMs: number) {
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });

  return new Proxy(engine, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if (
        property !== "getDomSnapshot" &&
        property !== "getHtmlSnapshot" &&
        property !== "getPageInfo" &&
        property !== "readText" &&
        property !== "readAttributes"
      ) {
        return value.bind(target);
      }

      return async (...args: unknown[]) => {
        await wait(delayMs);
        return value.apply(target, args);
      };
    },
  }) as BrowserCoreEngine & {
    dispose?: () => Promise<void>;
  };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
