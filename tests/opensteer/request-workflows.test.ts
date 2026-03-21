import { execFile as execFileCallback } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { promisify } from "node:util";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BodyPayload,
  HeaderEntry,
  NetworkRecord,
  NetworkQueryRecord,
  OpensteerRequestPlanPayload,
} from "../../packages/protocol/src/index.js";
import {
  createBodyPayload,
  createHeaderEntry,
  createNetworkRequestId,
  createPageRef,
  createSessionRef,
} from "../../packages/protocol/src/index.js";
import { Opensteer, createFilesystemOpensteerRoot } from "../../packages/opensteer/src/index.js";
import { ensureOpensteerService } from "../../packages/opensteer/src/cli/client.js";
import { inferRequestPlanFromNetworkRecord } from "../../packages/opensteer/src/requests/inference.js";
import { normalizeRequestPlanPayload } from "../../packages/opensteer/src/requests/plans/index.js";
import {
  cleanupPhase6TemporaryRoots,
  createPhase6TemporaryRoot,
  startPhase6FixtureServer,
  type Phase6FixtureServer,
} from "./phase6-fixture.js";
import { ensureCliArtifactsBuilt } from "./cli-artifacts.js";

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");
const CLI_EXEC_ARGV: readonly string[] = [];

let fixtureServer: Phase6FixtureServer | undefined;

beforeAll(async () => {
  fixtureServer = await startPhase6FixtureServer();
  await ensureCliArtifactsBuilt();
}, 120_000);

afterEach(async () => {
  await cleanupPhase6TemporaryRoots();
});

afterAll(async () => {
  await fixtureServer?.close();
});

describe("Phase 10 request workflows", () => {
  test("normalizes valid request plans and rejects invalid transport and path definitions", () => {
    const normalized = normalizeRequestPlanPayload({
      transport: {
        kind: "session-http",
      },
      endpoint: {
        method: " post ",
        urlTemplate: " https://example.com/api/users/{userId}/orders ",
      },
      parameters: [{ name: "userId", in: "path" }],
      response: {
        status: 200,
        contentType: "Application/Json",
      },
    });

    expect(normalized).toMatchObject({
      transport: {
        kind: "session-http",
        requiresBrowser: true,
      },
      endpoint: {
        method: "POST",
        urlTemplate: "https://example.com/api/users/{userId}/orders",
      },
      response: {
        status: 200,
        contentType: "application/json",
      },
    });

    expect(() =>
      normalizeRequestPlanPayload({
        transport: {
          kind: "session-http",
          requiresBrowser: false,
        },
        endpoint: {
          method: "GET",
          urlTemplate: "https://example.com/api/users/{userId}",
        },
        parameters: [{ name: "userId", in: "path" }],
      }),
    ).toThrow(/requiresBrowser/);

    expect(() =>
      normalizeRequestPlanPayload({
        transport: {
          kind: "session-http",
        },
        endpoint: {
          method: "GET",
          urlTemplate: "https://example.com/api/users/{userId}",
        },
        parameters: [{ name: "accountId", in: "path" }],
      }),
    ).toThrow(/missing a path parameter|exactly match/);

    expect(() =>
      normalizeRequestPlanPayload({
        transport: {
          kind: "session-http",
        },
        endpoint: {
          method: "GET",
          urlTemplate: "https://example.com/api/users/{userId}",
        },
        parameters: [
          { name: "userId", in: "path" },
          { name: "userId", in: "path" },
        ],
      }),
    ).toThrow(/duplicate request plan parameter/);

    expect(() =>
      normalizeRequestPlanPayload({
        transport: {
          kind: "session-http",
        },
        endpoint: {
          method: "GET",
          urlTemplate: "https://example.com/api/users/{userId}",
        },
        parameters: [
          { name: "userId", in: "path" },
          { name: "csrf", in: "header", wireName: "   " },
        ],
      }),
    ).toThrow(/parameter\.wireName must be a non-empty string/);

    expect(() =>
      normalizeRequestPlanPayload({
        transport: {
          kind: "session-http",
        },
        endpoint: {
          method: "GET",
          urlTemplate: "https://example.com/api/users/{userId}",
          defaultHeaders: [{ name: ":authority", value: "example.com" }],
        },
        parameters: [{ name: "userId", in: "path" }],
      }),
    ).toThrow(/valid HTTP header name/);

    expect(() =>
      normalizeRequestPlanPayload({
        transport: {
          kind: "session-http",
        },
        endpoint: {
          method: "GET",
          urlTemplate: "https://example.com/api/users/{userId}",
        },
        parameters: [
          { name: "userId", in: "path" },
          { name: "csrf", in: "header", wireName: "bad header" },
        ],
      }),
    ).toThrow(/valid HTTP header name/);
  });

  test("request-plan inference keeps only replayable headers while preserving auth inference", () => {
    const inferred = inferRequestPlanFromNetworkRecord(
      createSavedNetworkRecord({
        recordId: "record:inferred-headers",
        requestId: createNetworkRequestId("inferred-headers"),
        url: "https://example.com/api/search?q=airpods",
        requestHeaders: [
          createHeaderEntry(":authority", "example.com"),
          createHeaderEntry("accept", "application/json"),
          createHeaderEntry("accept-language", "en-US,en;q=0.9"),
          createHeaderEntry("content-type", "application/json"),
          createHeaderEntry("sec-fetch-mode", "cors"),
          createHeaderEntry("user-agent", "agent-browser"),
          createHeaderEntry("x-auth-token", "[redacted]"),
          createHeaderEntry("x-client-version", "web-2026.03"),
        ],
      }),
      {
        recordId: "record:inferred-headers",
        key: "phase10-header-filter",
        version: "1.0.0",
      },
    );

    expect(inferred.payload.auth?.strategy).toBe("api-key");
    expect(inferred.payload.endpoint.defaultHeaders).toEqual([
      { name: "accept", value: "application/json" },
      { name: "content-type", value: "application/json" },
      { name: "x-client-version", value: "web-2026.03" },
    ]);
  });

  test("SDK exposes page lifecycle, evaluate, and wait primitives for browser-first flows", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-page-primitives",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      const opened = await opensteer.open(`${baseUrl}/phase6/main`);
      const initialPages = await opensteer.listPages();
      expect(initialPages.activePageRef).toBe(opened.pageRef);
      expect(initialPages.pages.map((page) => page.pageRef)).toContain(opened.pageRef);
      const initialPageCount = initialPages.pages.length;

      const waitedPagePromise = opensteer.waitForPage({
        openerPageRef: opened.pageRef,
        urlIncludes: "/phase10/page-http",
        timeoutMs: 10_000,
      });
      const created = await opensteer.newPage({
        openerPageRef: opened.pageRef,
        url: `${baseUrl}/phase10/page-http`,
      });
      const waitedPage = await waitedPagePromise;
      expect(waitedPage.pageRef).toBe(created.pageRef);
      expect(waitedPage.openerPageRef).toBe(opened.pageRef);

      const pagesAfterCreate = await opensteer.listPages();
      expect(pagesAfterCreate.activePageRef).toBe(created.pageRef);
      expect(pagesAfterCreate.pages).toHaveLength(initialPageCount + 1);

      const pageEvalData = await opensteer.evaluateJson({
        pageRef: created.pageRef,
        script:
          "() => ({ href: window.location.href, marker: document.querySelector('#phase10-page-http')?.textContent?.trim() ?? '' })",
      });
      expect(pageEvalData).toEqual({
        href: `${baseUrl}/phase10/page-http`,
        marker: "page http ready",
      });

      await opensteer.activatePage({
        pageRef: opened.pageRef,
      });
      expect(await opensteer.evaluate("() => document.title")).toBe("Phase 6 main");

      const networkRecordPromise = opensteer.waitForNetwork({
        path: "/phase10/api/capture",
        method: "POST",
        includeBodies: true,
        timeoutMs: 10_000,
      });
      const responseRecordPromise = opensteer.waitForResponse({
        path: "/phase10/api/capture",
        status: "200",
        includeBodies: true,
        timeoutMs: 10_000,
      });
      await opensteer.goto({
        url: `${baseUrl}/phase10/capture`,
      });
      const networkRecord = await networkRecordPromise;
      const responseRecord = await responseRecordPromise;
      expect(networkRecord.record.url).toBe(`${baseUrl}/phase10/api/capture?step=load`);
      expect(responseRecord.record.url).toBe(networkRecord.record.url);
      expect(decodeBody(networkRecord.record.requestBody)).toContain('"hello":"capture"');

      const closed = await opensteer.closePage({
        pageRef: created.pageRef,
      });
      expect(closed.closedPageRef).toBe(created.pageRef);
      expect(closed.activePageRef).toBe(opened.pageRef);
      expect(closed.pages).toHaveLength(initialPageCount);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("page-http runs inside the live page context while context-http does not", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-page-http-transport",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/phase10/page-http`);

      const contextResult = await opensteer.rawRequest({
        url: `${baseUrl}/phase10/api/page-http-protected`,
        transport: "context-http",
      });
      expect(contextResult.response.status).toBe(403);
      expect(contextResult.data).toMatchObject({
        ok: false,
        code: "missing-page-context",
      });

      const pageHttpResult = await opensteer.rawRequest({
        url: `${baseUrl}/phase10/api/page-http-protected`,
        transport: "page-http",
      });
      expect(pageHttpResult.response.status).toBe(200);
      expect(pageHttpResult.data).toMatchObject({
        ok: true,
        mode: "page-http",
      });

      const crossOriginUrl = new URL(`${baseUrl}/phase10/api/page-http-cors`);
      crossOriginUrl.hostname = "localhost";
      const crossOriginResult = await opensteer.rawRequest({
        url: crossOriginUrl.toString(),
        transport: "page-http",
      });
      expect(crossOriginResult.response.status).toBe(200);
      expect(crossOriginResult.data).toMatchObject({
        ok: true,
        mode: "page-http",
        cors: true,
      });
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("interaction.capture accepts primitive args for automated scripts", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-interaction-args",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      const opened = await opensteer.open(`${baseUrl}/phase10/interaction`);
      const trace = await opensteer.interactionCapture({
        pageRef: opened.pageRef,
        script: `(...args) => {
          document.body.setAttribute("data-phase10-args", JSON.stringify(args));
        }`,
        args: ["hello", 7, true, null],
      });
      expect(trace.trace.payload.mode).toBe("automated");
      const fetchedTrace = await opensteer.getInteraction({
        traceId: trace.trace.id,
      });
      expect(fetchedTrace.trace.id).toBe(trace.trace.id);
      expect(
        await opensteer.evaluateJson({
          pageRef: opened.pageRef,
          script: `() => document.body.getAttribute("data-phase10-args")`,
        }),
      ).toBe('["hello",7,true,null]');
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("interaction.capture steps execute browser actions and capture downstream network", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-interaction-steps",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      const opened = await opensteer.open(`${baseUrl}/phase10/interaction`);
      const trace = await opensteer.interactionCapture({
        pageRef: opened.pageRef,
        includeStorage: true,
        steps: [
          {
            kind: "input",
            target: {
              kind: "selector",
              selector: "#phase10-interaction-input",
            },
            text: "MRSU6648297",
          },
          {
            kind: "click",
            target: {
              kind: "selector",
              selector: "#phase10-interaction-submit",
            },
          },
          {
            kind: "wait",
            durationMs: 250,
          },
        ],
      });

      expect(trace.trace.payload.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "input" }),
          expect.objectContaining({ type: "click" }),
        ]),
      );
      expect(trace.trace.payload.networkRecordIds.length).toBeGreaterThan(0);
      expect(trace.trace.payload.stateDelta?.cookiesChanged).toContain("phase10-interaction");
      expect(
        await opensteer.evaluateJson({
          pageRef: opened.pageRef,
          script: `() => document.querySelector("#phase10-interaction-status")?.textContent?.trim() ?? ""`,
        }),
      ).toBe("MRSU6648297");

      const captured = await opensteer.waitForNetwork({
        path: "/phase10/api/interaction-submit",
        resourceType: "fetch",
        includeBodies: true,
      });
      expect(captured.record.method).toBe("POST");
      expect(captured.record.status).toBe(200);
      expect(captured.record.responseBody).toBeDefined();
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("addInitScript runs before page scripts and captureScripts persists inline, external, dynamic, and worker sources", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-instrumentation-capture",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open();
      await opensteer.addInitScript('() => { window.__phase10Init = "ready"; }');
      await opensteer.goto(`${baseUrl}/phase10/init-script-target`);
      await expect(opensteer.evaluate("() => window.phase10InitValue")).resolves.toBe("ready");

      await opensteer.goto(`${baseUrl}/phase10/scripts?worker=1`);
      await opensteer.waitForNetwork({
        path: "/phase10/assets/script-dynamic.js",
        resourceType: "script",
      });
      await opensteer.waitForNetwork({
        path: "/phase10/assets/script-worker.js",
        resourceType: "script",
      });

      const captured = await opensteer.captureScripts({
        includeDynamic: true,
        includeWorkers: true,
      });

      expect(
        captured.scripts.some(
          (script) => script.source === "inline" && script.content.includes("phase10Inline"),
        ),
      ).toBe(true);
      expect(
        captured.scripts.some(
          (script) =>
            script.source === "external" && script.url?.includes("/phase10/assets/script-a.js"),
        ),
      ).toBe(true);
      expect(
        captured.scripts.some(
          (script) =>
            script.source === "dynamic" &&
            script.url?.includes("/phase10/assets/script-dynamic.js"),
        ),
      ).toBe(true);
      expect(
        captured.scripts.some(
          (script) =>
            script.source === "worker" && script.url?.includes("/phase10/assets/script-worker.js"),
        ),
      ).toBe(true);
      expect(captured.scripts.every((script) => script.artifactId !== undefined)).toBe(true);
      const artifact = await opensteer.readArtifact({
        artifactId: captured.scripts[0]!.artifactId!,
      });
      expect(artifact.artifact.kind).toBe("script-source");

      await runCliCommand(rootDir, [
        "open",
        `${baseUrl}/phase10/scripts`,
        "--name",
        "phase10-cli-capture",
        "--root-dir",
        rootDir,
        "--headless",
        "true",
      ]);
      const cliCaptured = await runCliCommand(rootDir, [
        "scripts",
        "capture",
        "--name",
        "phase10-cli-capture",
        "--root-dir",
        rootDir,
        "--include-dynamic",
        "true",
      ]);
      expect(
        (cliCaptured as { scripts: readonly { source: string }[] }).scripts.length,
      ).toBeGreaterThan(0);
      await runCliCommand(rootDir, [
        "close",
        "--name",
        "phase10-cli-capture",
        "--root-dir",
        rootDir,
      ]);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("route can continue, fulfill, and abort requests while interceptScript replaces script responses", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-routing",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open();
      await opensteer.interceptScript({
        urlPattern: `${baseUrl}/phase10/assets/route-script.js`,
        handler: async ({ content }) => content.replace('"original"', '"replaced"'),
      });
      await opensteer.route({
        urlPattern: `${baseUrl}/phase10/api/route-data`,
        handler: async () => ({
          kind: "fulfill",
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({ value: "fulfilled" }),
        }),
      });
      await opensteer.goto(`${baseUrl}/phase10/route-target`);
      await expect(opensteer.evaluate("() => window.phase10RouteScript")).resolves.toBe("replaced");
      await expect(
        opensteer.waitForNetwork({
          path: "/phase10/api/route-data",
          resourceType: "fetch",
        }),
      ).resolves.toBeDefined();
      await expect(opensteer.evaluate("() => window.phase10RouteFetch")).resolves.toBe("fulfilled");

      const aborted = new Opensteer({
        name: "phase10-routing-abort",
        rootDir,
        browser: {
          headless: true,
        },
      });
      try {
        await aborted.open();
        await aborted.route({
          urlPattern: `${baseUrl}/phase10/api/route-data`,
          handler: async () => ({
            kind: "abort",
          }),
        });
        await aborted.goto(`${baseUrl}/phase10/route-target`);
        await expect(aborted.evaluate("() => window.phase10RouteFetch")).resolves.toBe("aborted");
      } finally {
        await aborted.close().catch(() => undefined);
      }
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("generic recipes can sync browser cookies, inject form body variables, and run through the recipe surface", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-generic-recipes",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/phase10/session`);

      await opensteer.writeRecipe({
        key: "phase10-cookie-jar-sync",
        version: "1.0.0",
        payload: {
          steps: [
            {
              kind: "syncCookiesToJar",
              jar: "phase10-browser-jar",
              urls: [baseUrl],
            },
          ],
        },
      });

      await opensteer.writeRequestPlan({
        key: "phase10-cookie-jar-plan",
        version: "1.0.0",
        payload: {
          transport: {
            kind: "direct-http",
            cookieJar: "phase10-browser-jar",
          },
          endpoint: {
            method: "GET",
            urlTemplate: `${baseUrl}/phase10/api/session-http?source=jar-sync`,
          },
          response: {
            status: 200,
            contentType: "application/json",
          },
          recipes: {
            prepare: {
              recipe: {
                key: "phase10-cookie-jar-sync",
                version: "1.0.0",
              },
              cachePolicy: "untilFailure",
            },
          },
        },
      });

      const cookieResult = await opensteer.request("phase10-cookie-jar-plan");
      expect(cookieResult.data).toMatchObject({
        cookie: expect.stringContaining("phase10-session=abc123"),
        source: "jar-sync",
      });

      await opensteer.writeRecipe({
        key: "phase10-form-token",
        version: "1.0.0",
        payload: {
          steps: [
            {
              kind: "request",
              request: {
                transport: "direct-http",
                url: `${baseUrl}/phase10/api/direct-refresh`,
                method: "POST",
              },
              capture: {
                bodyJsonPointer: {
                  pointer: "/token",
                  saveAs: "token",
                },
              },
            },
          ],
          outputs: {
            body: {
              "recaptcha-token": "{{token}}",
            },
          },
        },
      });

      const storedRecipe = await opensteer.getRecipe({
        key: "phase10-form-token",
        version: "1.0.0",
      });
      expect(storedRecipe.key).toBe("phase10-form-token");
      expect((await opensteer.listRecipes()).recipes.map((recipe) => recipe.key)).toContain(
        "phase10-form-token",
      );

      const recipeRun = await opensteer.runRecipe({
        key: "phase10-form-token",
        version: "1.0.0",
      });
      expect(recipeRun.variables.token).toBe("phase10-refreshed");
      expect(recipeRun.overrides?.body?.["recaptcha-token"]).toBe("phase10-refreshed");

      await opensteer.writeRequestPlan({
        key: "phase10-form-template",
        version: "1.0.0",
        payload: {
          transport: {
            kind: "direct-http",
          },
          endpoint: {
            method: "POST",
            urlTemplate: `${baseUrl}/phase10/api/form-protected?source=recipe-prepare`,
          },
          body: {
            kind: "form",
            fields: [
              {
                name: "recaptcha-token",
                value: "{{recaptcha-token}}",
              },
            ],
          },
          response: {
            status: 200,
            contentType: "application/json",
          },
          recipes: {
            prepare: {
              recipe: {
                key: "phase10-form-token",
                version: "1.0.0",
              },
              cachePolicy: "none",
            },
          },
        },
      });

      const formResult = await opensteer.request("phase10-form-template");
      expect(formResult.data).toMatchObject({
        ok: true,
        mode: "form-template",
        token: "phase10-refreshed",
        query: "recipe-prepare",
      });

      await opensteer.writeRecipe({
        key: "phase10-kernel-overrides",
        version: "1.0.0",
        payload: {
          steps: [
            {
              kind: "request",
              request: {
                transport: "direct-http",
                url: `${baseUrl}/phase10/api/direct-refresh`,
                method: "POST",
              },
              capture: {
                bodyJsonPointer: {
                  pointer: "/token",
                  saveAs: "token",
                },
              },
            },
          ],
          outputs: {
            query: {
              token: "{{token}}",
            },
            headers: {
              "x-phase10-token": "{{token}}",
            },
            body: {
              token: "{{token}}",
            },
          },
        },
      });

      await opensteer.writeRequestPlan({
        key: "phase10-kernel-overrides-plan",
        version: "1.0.0",
        payload: {
          transport: {
            kind: "direct-http",
          },
          endpoint: {
            method: "POST",
            urlTemplate: `${baseUrl}/phase10/api/kernel-parity`,
          },
          body: {
            kind: "form",
            fields: [
              {
                name: "token",
                value: "{{token}}",
              },
            ],
          },
          response: {
            status: 200,
            contentType: "application/json",
          },
          recipes: {
            prepare: {
              recipe: {
                key: "phase10-kernel-overrides",
                version: "1.0.0",
              },
              cachePolicy: "none",
            },
          },
        },
      });

      const parityResult = await opensteer.request("phase10-kernel-overrides-plan");
      expect(parityResult.data).toMatchObject({
        ok: true,
        query: "phase10-refreshed",
        header: "phase10-refreshed",
        form: "phase10-refreshed",
      });
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("request plans retry transient failures after recovery handling", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-retry-policy",
      rootDir,
    });

    await opensteer.writeRequestPlan({
      key: "phase10-retry-plan",
      version: "1.0.0",
      payload: {
        transport: {
          kind: "direct-http",
        },
        endpoint: {
          method: "GET",
          urlTemplate: `${baseUrl}/phase10/api/retry-once?key=phase10-retry-plan`,
        },
        response: {
          status: 200,
          contentType: "application/json",
        },
        retryPolicy: {
          maxRetries: 1,
          respectRetryAfter: true,
          failurePolicy: {
            statusCodes: [429],
          },
        },
      },
    });

    const result = await opensteer.request("phase10-retry-plan");
    expect(result.data).toMatchObject({
      ok: true,
      mode: "retry-policy",
      attempt: 2,
    });
  });

  test("SDK retries session-http plans with a deterministic auth recipe in the same browser session", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-session-recovery",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/phase10/session`);
      await opensteer.writeAuthRecipe({
        key: "phase10-session-refresh",
        version: "1.0.0",
        payload: {
          steps: [
            {
              kind: "sessionRequest",
              request: {
                url: `${baseUrl}/phase10/api/refresh-cookie`,
                method: "POST",
              },
            },
          ],
        },
      });
      await opensteer.writeRequestPlan({
        key: "phase10-session-protected",
        version: "1.0.0",
        payload: {
          transport: {
            kind: "session-http",
          },
          endpoint: {
            method: "GET",
            urlTemplate: `${baseUrl}/phase10/api/recovery-session`,
          },
          response: {
            status: 200,
            contentType: "application/json",
          },
          auth: {
            strategy: "session-cookie",
            recipe: {
              key: "phase10-session-refresh",
            },
            failurePolicy: {
              statusCodes: [401],
            },
          },
        },
      });

      const result = await opensteer.request("phase10-session-protected");
      expect(result.data).toMatchObject({
        ok: true,
        mode: "session-http",
      });
      expect(result.recovery).toMatchObject({
        attempted: true,
        succeeded: true,
        matchedFailurePolicy: true,
        recipe: {
          key: "phase10-session-refresh",
          version: "1.0.0",
        },
      });
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  });

  test("SDK executes direct-http plans without opening a browser and retries with deterministic header recovery", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-direct-recovery",
      rootDir,
    });

    await opensteer.writeAuthRecipe({
      key: "phase10-direct-refresh",
      version: "1.0.0",
      payload: {
        steps: [
          {
            kind: "directRequest",
            request: {
              url: `${baseUrl}/phase10/api/direct-refresh`,
              method: "POST",
            },
            capture: {
              bodyJsonPointer: {
                pointer: "/token",
                saveAs: "token",
              },
            },
          },
        ],
        outputs: {
          headers: {
            authorization: "Bearer {{token}}",
          },
        },
      },
    });
    await opensteer.writeRequestPlan({
      key: "phase10-direct-protected",
      version: "1.0.0",
      payload: {
        transport: {
          kind: "direct-http",
        },
        endpoint: {
          method: "GET",
          urlTemplate: `${baseUrl}/phase10/api/direct-protected`,
        },
        response: {
          status: 200,
          contentType: "application/json",
        },
        auth: {
          strategy: "bearer-token",
          recipe: {
            key: "phase10-direct-refresh",
          },
          failurePolicy: {
            statusCodes: [401],
          },
        },
      },
    });

    const result = await opensteer.request("phase10-direct-protected");
    expect(result.data).toMatchObject({
      ok: true,
      mode: "direct-http",
    });
    expect(result.recovery).toMatchObject({
      attempted: true,
      succeeded: true,
      recipe: {
        key: "phase10-direct-refresh",
        version: "1.0.0",
      },
    });
  });

  test("direct-http auth recovery fails with browser-required when the recipe needs browser state", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-browser-required",
      rootDir,
    });

    await opensteer.writeAuthRecipe({
      key: "phase10-cookie-refresh",
      version: "1.0.0",
      payload: {
        steps: [
          {
            kind: "readCookie",
            name: "phase10-session",
            saveAs: "token",
          },
        ],
        outputs: {
          headers: {
            authorization: "Bearer {{token}}",
          },
        },
      },
    });
    await opensteer.writeRequestPlan({
      key: "phase10-browser-required-plan",
      version: "1.0.0",
      payload: {
        transport: {
          kind: "direct-http",
        },
        endpoint: {
          method: "GET",
          urlTemplate: `${baseUrl}/phase10/api/direct-protected`,
        },
        auth: {
          strategy: "bearer-token",
          recipe: {
            key: "phase10-cookie-refresh",
          },
          failurePolicy: {
            statusCodes: [401],
          },
        },
      },
    });

    await expect(opensteer.request("phase10-browser-required-plan")).rejects.toMatchObject({
      code: "browser-required",
    });
  });

  test("CLI supports recipe CRUD and direct-http execution without a browser session", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;

    await runCliCommand(rootDir, [
      "recipe",
      "write",
      "--key",
      "phase10-cli-direct-refresh",
      "--version",
      "1.0.0",
      "--payload",
      JSON.stringify({
        steps: [
          {
            kind: "directRequest",
            request: {
              url: `${baseUrl}/phase10/api/direct-refresh`,
              method: "POST",
            },
            capture: {
              bodyJsonPointer: {
                pointer: "/token",
                saveAs: "token",
              },
            },
          },
        ],
        outputs: {
          headers: {
            authorization: "Bearer {{token}}",
          },
        },
      }),
    ]);

    const listed = (await runCliCommand(rootDir, ["recipe", "list"])) as {
      readonly recipes: readonly { readonly key: string }[];
    };
    expect(listed.recipes.map((entry) => entry.key)).toContain("phase10-cli-direct-refresh");

    const recipe = (await runCliCommand(rootDir, [
      "recipe",
      "run",
      "phase10-cli-direct-refresh",
    ])) as {
      readonly variables: Record<string, string>;
      readonly overrides?: {
        readonly headers?: Record<string, string>;
      };
    };
    expect(recipe.variables.token).toBe("phase10-refreshed");
    expect(recipe.overrides?.headers?.authorization).toBe("Bearer phase10-refreshed");

    const directRaw = (await runCliCommand(rootDir, [
      "request",
      "raw",
      "--transport",
      "direct-http",
      "--url",
      `${baseUrl}/phase10/api/direct-refresh`,
      "--method",
      "POST",
    ])) as {
      readonly recordId: string;
      readonly data: Record<string, unknown>;
    };
    expect(directRaw.recordId).toEqual(expect.any(String));
    expect(directRaw.data).toMatchObject({
      token: "phase10-refreshed",
    });
  }, 60_000);

  test("SDK supports the live reverse-engineering workflow end to end", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-sdk",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/phase10/session`);
      await opensteer.goto({
        url: `${baseUrl}/phase10/capture`,
        networkTag: "phase10-live-capture",
      });
      const queried = await opensteer.queryNetwork({
        url: "/phase10/api/capture",
        includeBodies: true,
      });
      expect(queried.records).toHaveLength(1);

      const captureRecord = queried.records[0]!;
      expect(captureRecord.source).toBe("live");
      expect(captureRecord.record.method).toBe("POST");
      expect(captureRecord.record.url).toBe(`${baseUrl}/phase10/api/capture?step=load`);
      expect(readHeader(captureRecord.record.requestHeaders, "authorization")).toBe("[redacted]");
      expect(readHeader(captureRecord.record.requestHeaders, "cookie")).toBe("[redacted]");
      expect(readHeader(captureRecord.record.requestHeaders, "x-csrf-token")).toBe("csrf-visible");
      expect(readHeader(captureRecord.record.responseHeaders, "set-cookie")).toBe("[redacted]");
      expect(decodeBody(captureRecord.record.requestBody)).toContain('"hello":"capture"');
      expect(captureRecord.actionId).toEqual(expect.any(String));
      expect(captureRecord.tags).toContain("phase10-live-capture");

      const filteredLive = await opensteer.queryNetwork({
        hostname: new URL(baseUrl).hostname,
        path: "/phase10/api/capture",
        method: "po",
        status: "20",
        resourceType: "fetch",
      });
      expect(filteredLive.records.map((record) => record.recordId)).toContain(
        captureRecord.recordId,
      );

      const byAction = await opensteer.queryNetwork({
        actionId: captureRecord.actionId,
      });
      expect(byAction.records.map((record) => record.recordId)).toContain(captureRecord.recordId);

      const byTag = await opensteer.queryNetwork({
        tag: "phase10-live-capture",
      });
      expect(byTag.records.map((record) => record.recordId)).toContain(captureRecord.recordId);

      const saved = await opensteer.saveNetwork({
        recordId: captureRecord.recordId,
        tag: "phase10-capture",
      });
      expect(saved.savedCount).toBe(1);

      const savedQuery = await opensteer.queryNetwork({
        source: "saved",
        tag: "phase10-capture",
        includeBodies: true,
      });
      expect(savedQuery.records).toHaveLength(1);
      expect(savedQuery.records[0]?.source).toBe("saved");
      expect(savedQuery.records[0]?.savedAt).toEqual(expect.any(Number));

      const inferredCapture = await opensteer.inferRequestPlan({
        recordId: savedQuery.records[0]!.recordId,
        key: "phase10-capture-inferred",
        version: "1.0.0",
      });
      expect(inferredCapture.payload.auth?.strategy).toBe("bearer-token");

      const raw = await opensteer.rawRequest({
        url: `${baseUrl}/phase10/api/session-http?source=raw-sdk`,
        method: "POST",
        headers: [{ name: "x-csrf-token", value: "csrf-sdk" }],
        body: {
          json: {
            item: "widget-99",
            quantity: 3,
          },
        },
      });
      expect(raw.recordId).toEqual(expect.any(String));
      expect(raw.data).toMatchObject({
        cookie: expect.stringContaining("phase10-session=abc123"),
        csrf: "csrf-sdk",
        source: "raw-sdk",
        body: {
          item: "widget-99",
          quantity: 3,
        },
      });

      const inferred = await opensteer.inferRequestPlan({
        recordId: raw.recordId,
        key: "phase10-inferred-raw",
        version: "1.0.0",
      });
      expect(inferred.payload.endpoint.method).toBe("POST");
      expect(inferred.payload.endpoint.urlTemplate).toBe(`${baseUrl}/phase10/api/session-http`);
      expect(inferred.payload.endpoint.defaultQuery).toEqual([
        {
          name: "source",
          value: "raw-sdk",
        },
      ]);

      const listed = await opensteer.listRequestPlans();
      expect(listed.plans.map((entry) => entry.key)).toContain("phase10-inferred-raw");

      const executed = await opensteer.request("phase10-inferred-raw", {
        version: "1.0.0",
        body: {
          json: {
            item: "widget-100",
            quantity: 1,
          },
        },
      });
      expect(executed.data).toMatchObject({
        cookie: expect.stringContaining("phase10-session=abc123"),
        csrf: "",
        source: "raw-sdk",
        body: {
          item: "widget-100",
          quantity: 1,
        },
      });

      const refreshed = await opensteer.getRequestPlan({
        key: "phase10-inferred-raw",
        version: "1.0.0",
      });
      expect(refreshed.freshness?.lastValidatedAt).toEqual(expect.any(Number));

      const root = await createFilesystemOpensteerRoot({
        rootPath: path.join(rootDir, ".opensteer"),
      });
      const runIds = await listRunIds(rootDir);
      expect(runIds).toHaveLength(1);
      const traceEntries = await root.traces.listEntries(runIds[0]!);
      expect(traceEntries.some((entry) => entry.operation === "network.query")).toBe(true);
      expect(traceEntries.some((entry) => entry.operation === "request.raw")).toBe(true);
      expect(traceEntries.some((entry) => entry.operation === "request-plan.infer")).toBe(true);

      const cleared = await opensteer.clearNetwork({
        tag: "phase10-capture",
      });
      expect(cleared.clearedCount).toBe(1);
      const afterClear = await opensteer.queryNetwork({
        source: "saved",
        tag: "phase10-capture",
      });
      expect(afterClear.records).toHaveLength(0);
    } finally {
      await opensteer.close();
    }
  }, 60_000);

  test("reverse.solve emits a runnable portable package with report and export artifacts", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-reverse-solve",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open();
      await opensteer.goto(`${baseUrl}/phase10/route-target`);
      await expect(
        opensteer.waitForNetwork({
          path: "/phase10/api/route-data",
          resourceType: "fetch",
          includeBodies: true,
        }),
      ).resolves.toBeDefined();

      const solved = await opensteer.reverseSolve({
        objective: "Reverse engineer phase10 route target",
        network: {
          path: "/phase10/api/route-data",
          includeBodies: true,
        },
      });
      expect(solved.package.payload.kind).toBe("portable-http");
      expect(solved.package.payload.readiness).toBe("runnable");
      expect(solved.package.payload.requestPlanId).toEqual(expect.any(String));
      expect(solved.package.payload.workflow).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "operation",
            operation: "request.raw",
          }),
          expect.objectContaining({
            kind: "assert",
          }),
        ]),
      );
      expect(solved.package.payload.validators).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "status",
          }),
        ]),
      );
      expect(solved.report.payload.packageId).toBe(solved.package.id);
      expect(solved.report.payload.packageKind).toBe("portable-http");
      expect(solved.report.payload.candidateRankings[0]?.candidateId).toBe(
        solved.report.payload.chosenCandidateId,
      );
      const fetchedPackage = await opensteer.getReversePackage({
        packageId: solved.package.id,
      });
      expect(fetchedPackage.package.id).toBe(solved.package.id);
      const listedPackages = await opensteer.listReversePackages({
        caseId: solved.caseId,
      });
      expect(listedPackages.packages.map((entry) => entry.id)).toContain(solved.package.id);
      const patchedPackage = await opensteer.patchReversePackage({
        packageId: solved.package.id,
        notes: "patched portable package",
      });
      expect(patchedPackage.package.id).not.toBe(solved.package.id);
      expect(patchedPackage.package.payload.parentPackageId).toBe(solved.package.id);
      expect(patchedPackage.package.payload.notes).toBe("patched portable package");
      expect(patchedPackage.report.payload.packageId).toBe(patchedPackage.package.id);

      const replayed = await opensteer.reverseReplay({
        packageId: solved.package.id,
      });
      expect(replayed.success).toBe(true);
      expect(replayed.kind).toBe("portable-http");
      expect(replayed.status).toBe(200);

      const root = await createFilesystemOpensteerRoot({
        rootPath: path.join(rootDir, ".opensteer"),
      });
      const caseRecordPath = await findRegistryRecordPathById(
        root.registry.reverseCases.recordsDirectory,
        solved.caseId,
      );
      expect(caseRecordPath).toBeDefined();
      if (caseRecordPath === undefined) {
        throw new Error(`expected reverse case record ${solved.caseId} to exist`);
      }
      await unlink(caseRecordPath);

      const replayedFromStandalonePackage = await opensteer.reverseReplay({
        packageId: solved.package.id,
      });
      expect(replayedFromStandalonePackage.success).toBe(true);
      expect(replayedFromStandalonePackage.kind).toBe("portable-http");

      const exported = await opensteer.reverseExport({
        packageId: solved.package.id,
      });
      expect(exported.package.id).toBe(solved.package.id);
      expect(exported.requestPlan?.id).toBe(solved.package.payload.requestPlanId);

      const report = await opensteer.reverseReport({
        packageId: solved.package.id,
      });
      expect(report.report.id).toBe(solved.report.id);
      expect(report.report.payload.replayRuns.length).toBeGreaterThan(0);
    } finally {
      await opensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("browser-workflow packages restore captured observation state before standalone replay", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const solvingOpensteer = new Opensteer({
      name: "phase10-reverse-state-restore",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await solvingOpensteer.open(`${baseUrl}/phase10/stateful-prime`);
      await solvingOpensteer.goto(`${baseUrl}/phase10/stateful-target`);
      await expect(
        solvingOpensteer.waitForNetwork({
          path: "/phase10/api/stateful-replay",
          resourceType: "fetch",
          includeBodies: true,
        }),
      ).resolves.toBeDefined();

      const solved = await solvingOpensteer.reverseSolve({
        objective: "Reverse engineer phase10 stateful replay",
        targetHints: {
          paths: ["/phase10/api/stateful-replay"],
        },
        network: {
          path: "/phase10/api/stateful-replay",
          includeBodies: true,
        },
      });

      expect(solved.package.payload.kind).toBe("browser-workflow");
      expect(solved.package.payload.readiness).toBe("runnable");
      expect(solved.package.payload.stateSnapshots.length).toBeGreaterThan(0);
      expect(solved.package.payload.stateSnapshots[0]?.cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "phase10-state",
            value: "armed",
          }),
        ]),
      );
      expect(solved.package.payload.stateSnapshots[0]?.storage?.origins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: baseUrl,
            localStorage: expect.arrayContaining([
              expect.objectContaining({
                key: "phase10-state-token",
                value: "armed-token",
              }),
            ]),
          }),
        ]),
      );

      await solvingOpensteer.close();

      const root = await createFilesystemOpensteerRoot({
        rootPath: path.join(rootDir, ".opensteer"),
      });
      const caseRecordPath = await findRegistryRecordPathById(
        root.registry.reverseCases.recordsDirectory,
        solved.caseId,
      );
      expect(caseRecordPath).toBeDefined();
      if (caseRecordPath === undefined) {
        throw new Error(`expected reverse case record ${solved.caseId} to exist`);
      }
      await unlink(caseRecordPath);

      const replayOpensteer = new Opensteer({
        name: "phase10-reverse-state-restore-replay",
        rootDir,
        browser: {
          headless: true,
        },
      });

      try {
        await replayOpensteer.open();
        const replayed = await replayOpensteer.reverseReplay({
          packageId: solved.package.id,
        });
        expect(replayed.success).toBe(true);
        expect(replayed.kind).toBe("browser-workflow");
        expect(replayed.status).toBe(200);

        const storage = await replayOpensteer.getStorageSnapshot({
          includeSessionStorage: true,
        });
        expect(storage.origins).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              origin: baseUrl,
              localStorage: expect.arrayContaining([
                expect.objectContaining({
                  key: "phase10-state-token",
                  value: "armed-token",
                }),
              ]),
            }),
          ]),
        );
        expect(storage.sessionStorage).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              origin: baseUrl,
              entries: expect.arrayContaining([
                expect.objectContaining({
                  key: "phase10-state-session",
                  value: "armed-session",
                }),
              ]),
            }),
          ]),
        );
      } finally {
        await replayOpensteer.close().catch(() => undefined);
      }
    } finally {
      await solvingOpensteer.close().catch(() => undefined);
    }
  }, 60_000);

  test("inferred plans from saved records replay without pseudo-header cleanup", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const opensteer = new Opensteer({
      name: "phase10-saved-infer-replay",
      rootDir,
      browser: {
        headless: true,
      },
    });

    try {
      await opensteer.open(`${baseUrl}/phase10/session`);

      const root = await createFilesystemOpensteerRoot({
        rootPath: path.join(rootDir, ".opensteer"),
      });
      const savedRecord = createSavedNetworkRecord({
        recordId: "record:phase10-saved-infer",
        requestId: createNetworkRequestId("phase10-saved-infer"),
        sessionRef: createSessionRef("saved-session"),
        pageRef: createPageRef("saved-page"),
        url: `${baseUrl}/phase10/api/session-http?source=saved-infer`,
        method: "POST",
        requestHeaders: [
          createHeaderEntry(":authority", "127.0.0.1"),
          createHeaderEntry("accept", "application/json"),
          createHeaderEntry("accept-language", "en-US,en;q=0.9"),
          createHeaderEntry("content-type", "application/json; charset=utf-8"),
          createHeaderEntry("cookie", "[redacted]"),
          createHeaderEntry("sec-fetch-mode", "cors"),
          createHeaderEntry("user-agent", "agent-browser"),
          createHeaderEntry("x-csrf-token", "[redacted]"),
        ],
        requestBody: createJsonBodyPayload({
          item: "saved-widget",
          quantity: 2,
        }),
      });
      await root.registry.savedNetwork.save([savedRecord], "phase10-saved-infer");

      const inferred = await opensteer.inferRequestPlan({
        recordId: savedRecord.recordId,
        key: "phase10-saved-infer",
        version: "1.0.0",
      });
      expect(inferred.payload.auth?.strategy).toBe("session-cookie");
      expect(inferred.payload.endpoint.defaultHeaders).toEqual([
        {
          name: "accept",
          value: "application/json",
        },
        {
          name: "content-type",
          value: "application/json; charset=utf-8",
        },
      ]);

      const executed = await opensteer.request("phase10-saved-infer", {
        version: "1.0.0",
        body: {
          json: {
            item: "saved-widget",
            quantity: 5,
          },
        },
      });
      expect(executed.data).toMatchObject({
        cookie: expect.stringContaining("phase10-session=abc123"),
        csrf: "",
        source: "saved-infer",
        body: {
          item: "saved-widget",
          quantity: 5,
        },
      });
    } finally {
      await opensteer.close();
    }
  }, 60_000);

  test("service returns protocol-typed request workflow errors", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const sessionName = "phase10-service-validation";
    const client = await ensureOpensteerService({
      name: sessionName,
      rootDir,
      launchContext: {
        execPath: process.execPath,
        execArgv: CLI_EXEC_ARGV,
        scriptPath: CLI_SCRIPT,
        cwd: process.cwd(),
      },
    });

    try {
      await client.invoke("session.open", {
        url: `${baseUrl}/phase10/session`,
        name: sessionName,
        browser: {
          headless: true,
        },
      });

      await expect(
        client.invoke("request-plan.write", {
          key: "phase10-invalid-plan",
          version: "1.0.0",
          payload: {
            transport: {
              kind: "session-http",
              requiresBrowser: false,
            },
            endpoint: {
              method: "GET",
              urlTemplate: `${baseUrl}/phase10/api/users/{userId}/orders`,
            },
            parameters: [{ name: "userId", in: "path" }],
          },
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        opensteerError: {
          code: "invalid-request",
        },
      });

      await expect(
        client.invoke("request.execute", {
          key: "phase10-missing-plan",
        }),
      ).rejects.toMatchObject({
        statusCode: 404,
        opensteerError: {
          code: "not-found",
        },
      });

      await client.invoke("request-plan.write", {
        key: "phase10-service-order",
        version: "1.0.0",
        payload: buildOrderPlanPayload(baseUrl),
      });

      await expect(
        client.invoke("request.execute", {
          key: "phase10-service-order",
          params: {
            userId: "u_service",
            unexpected: "true",
          },
          headers: {
            csrf: "csrf-service",
          },
          body: {
            json: {
              item: "widget-service",
            },
          },
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        opensteerError: {
          code: "invalid-request",
        },
      });
    } finally {
      await client.invoke("session.close", {}).catch(() => undefined);
    }
  }, 60_000);

  test("CLI exposes network query/save, request raw, plan infer, and request execute workflows", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const sessionName = "phase10-cli";
    const networkOutputPath = path.join(rootDir, "phase10-network.json");
    const rawBodyPath = path.join(rootDir, "phase10-raw-body.json");
    const rawOutputPath = path.join(rootDir, "phase10-raw.json");
    const requestOutputPath = path.join(rootDir, "phase10-response.json");

    await runCliCommand(rootDir, [
      "open",
      `${baseUrl}/phase10/session`,
      "--name",
      sessionName,
      "--headless",
      "true",
    ]);

    await runCliCommand(rootDir, ["goto", `${baseUrl}/phase10/capture`, "--name", sessionName]);
    await runCliCommand(rootDir, [
      "network",
      "query",
      "--name",
      sessionName,
      "--url",
      "/phase10/api/capture",
      "--include-bodies",
      "true",
      "--output",
      networkOutputPath,
    ]);
    await runCliCommand(rootDir, [
      "network",
      "query",
      "--name",
      sessionName,
      "--hostname",
      new URL(baseUrl).hostname,
      "--path",
      "/phase10/api/capture",
      "--method",
      "POST",
      "--status",
      "200",
      "--resource-type",
      "fetch",
      "--output",
      networkOutputPath,
    ]);

    const network = JSON.parse(await readFile(networkOutputPath, "utf8")) as {
      readonly records: readonly {
        readonly recordId: string;
        readonly record: NetworkRecord;
      }[];
    };
    expect(network.records).toHaveLength(1);
    expect(readHeader(network.records[0]!.record.requestHeaders, "authorization")).toBe(
      "[redacted]",
    );

    await runCliCommand(rootDir, [
      "network",
      "save",
      "--name",
      sessionName,
      "--record-id",
      network.records[0]!.recordId,
      "--tag",
      "phase10-cli-capture",
    ]);

    await writeFile(
      rawBodyPath,
      `${JSON.stringify({ item: "cli-widget", quantity: 4 })}\n`,
      "utf8",
    );
    await runCliCommand(rootDir, [
      "request",
      "raw",
      "--name",
      sessionName,
      "--url",
      `${baseUrl}/phase10/api/session-http?source=raw-cli`,
      "--method",
      "POST",
      "--header",
      "x-csrf-token=csrf-cli",
      "--body-file",
      rawBodyPath,
      "--output",
      rawOutputPath,
    ]);

    const raw = JSON.parse(await readFile(rawOutputPath, "utf8")) as {
      readonly recordId: string;
    };

    await runCliCommand(rootDir, [
      "plan",
      "infer",
      "--name",
      sessionName,
      "--record-id",
      raw.recordId,
      "--key",
      "phase10-cli-inferred",
      "--version",
      "1.0.0",
    ]);

    const listed = (await runCliCommand(rootDir, ["plan", "list", "--name", sessionName])) as {
      readonly plans: readonly { readonly key: string }[];
    };
    expect(listed.plans.map((entry) => entry.key)).toContain("phase10-cli-inferred");

    await runCliCommand(rootDir, [
      "request",
      "execute",
      "phase10-cli-inferred",
      "--name",
      sessionName,
      "--version",
      "1.0.0",
      "--body-json",
      JSON.stringify({ item: "cli-widget", quantity: 4 }),
      "--output",
      requestOutputPath,
    ]);

    const response = JSON.parse(await readFile(requestOutputPath, "utf8")) as {
      readonly data: Record<string, unknown>;
    };
    expect(response.data).toMatchObject({
      cookie: expect.stringContaining("phase10-session=abc123"),
      csrf: "",
      source: "raw-cli",
      body: {
        item: "cli-widget",
        quantity: 4,
      },
    });

    await runCliCommand(rootDir, ["close", "--name", sessionName]);
  }, 60_000);
});

function buildOrderPlanPayload(baseUrl: string): OpensteerRequestPlanPayload {
  return {
    transport: {
      kind: "session-http",
    },
    endpoint: {
      method: "post",
      urlTemplate: `${baseUrl}/phase10/api/users/{userId}/orders`,
      defaultQuery: [{ name: "page", value: "1" }],
      defaultHeaders: [{ name: "x-static", value: "static" }],
    },
    parameters: [
      { name: "userId", in: "path" },
      { name: "debug", in: "query" },
      { name: "csrf", in: "header", wireName: "x-csrf-token", required: true },
    ],
    body: {
      required: true,
      contentType: "application/json; charset=utf-8",
    },
    response: {
      status: 200,
      contentType: "application/json",
    },
    auth: {
      strategy: "session-cookie",
    },
  };
}

function createSavedNetworkRecord(input: {
  readonly recordId: string;
  readonly requestId: NetworkRecord["requestId"];
  readonly sessionRef?: NetworkRecord["sessionRef"];
  readonly pageRef?: NetworkRecord["pageRef"];
  readonly url: string;
  readonly method?: string;
  readonly requestHeaders?: readonly HeaderEntry[];
  readonly responseHeaders?: readonly HeaderEntry[];
  readonly requestBody?: BodyPayload;
}): NetworkQueryRecord {
  return {
    recordId: input.recordId,
    source: "live",
    record: {
      kind: "http",
      requestId: input.requestId,
      sessionRef: input.sessionRef ?? createSessionRef("saved-record-session"),
      ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
      method: input.method ?? "GET",
      url: input.url,
      requestHeaders: input.requestHeaders ?? [],
      responseHeaders: input.responseHeaders ?? [
        createHeaderEntry("content-type", "application/json; charset=utf-8"),
      ],
      status: 200,
      statusText: "OK",
      resourceType: "fetch",
      navigationRequest: false,
      ...(input.requestBody === undefined ? {} : { requestBody: input.requestBody }),
      responseBody: createJsonBodyPayload({
        ok: true,
      }),
    },
  };
}

function createJsonBodyPayload(value: unknown): BodyPayload {
  return createBodyPayload(Buffer.from(JSON.stringify(value), "utf8").toString("base64"), {
    mimeType: "application/json",
    charset: "utf-8",
  });
}

function readHeader(headers: readonly HeaderEntry[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function decodeBody(body: BodyPayload | undefined): string {
  if (body === undefined) {
    return "";
  }
  return Buffer.from(body.data, "base64").toString("utf8");
}

async function listRunIds(rootDir: string): Promise<readonly string[]> {
  const runsDirectory = path.join(rootDir, ".opensteer", "traces", "runs");
  return (await readdir(runsDirectory)).map((entry) => decodeURIComponent(entry));
}

function requireFixtureServer(): Phase6FixtureServer {
  if (!fixtureServer) {
    throw new Error("phase 10 fixture server is not running");
  }
  return fixtureServer;
}

async function runCliCommand(rootDir: string, args: readonly string[]): Promise<unknown> {
  const { stdout, stderr } = await execFile(
    process.execPath,
    [...CLI_EXEC_ARGV, CLI_SCRIPT, ...args],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
      },
      maxBuffer: 1024 * 1024 * 4,
    },
  );

  expect(stderr.trim()).toBe("");
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return JSON.parse(trimmed);
}

async function findRegistryRecordPathById(
  directory: string,
  recordId: string,
): Promise<string | undefined> {
  for (const fileName of await readdir(directory)) {
    const filePath = path.join(directory, fileName);
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (parsed !== null && typeof parsed === "object" && "id" in parsed && parsed.id === recordId) {
      return filePath;
    }
  }
  return undefined;
}
