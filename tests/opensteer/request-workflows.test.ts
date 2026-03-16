import { execFile as execFileCallback } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { promisify } from "node:util";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BodyPayload,
  HeaderEntry,
  NetworkRecord,
  OpensteerRequestPlanPayload,
} from "../../packages/protocol/src/index.js";
import {
  Opensteer,
  createFilesystemOpensteerRoot,
} from "../../packages/opensteer/src/index.js";
import { ensureOpensteerService } from "../../packages/opensteer/src/cli/client.js";
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
  });

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
      await opensteer.goto(`${baseUrl}/phase10/capture`);
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
        csrf: "csrf-sdk",
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
          },
          query: {
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

    const network = JSON.parse(await readFile(networkOutputPath, "utf8")) as {
      readonly records: readonly {
        readonly recordId: string;
        readonly record: NetworkRecord;
      }[];
    };
    expect(network.records).toHaveLength(1);
    expect(readHeader(network.records[0]!.record.requestHeaders, "authorization")).toBe("[redacted]");

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

    const listed = (await runCliCommand(rootDir, [
      "plan",
      "list",
      "--name",
      sessionName,
    ])) as {
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
      csrf: "csrf-cli",
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
  const { stdout, stderr } = await execFile(process.execPath, [...CLI_EXEC_ARGV, CLI_SCRIPT, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
    },
    maxBuffer: 1024 * 1024 * 4,
  });

  expect(stderr.trim()).toBe("");
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return JSON.parse(trimmed) as unknown;
}
