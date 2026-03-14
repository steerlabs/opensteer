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

const execFile = promisify(execFileCallback);
const CLI_SCRIPT = path.resolve(process.cwd(), "packages/opensteer/dist/cli/bin.js");

let fixtureServer: Phase6FixtureServer | undefined;

beforeAll(async () => {
  fixtureServer = await startPhase6FixtureServer();
});

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

  test("SDK captures redacted network records, persists artifacts and traces, and executes typed request plans", async () => {
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

      const started = await opensteer.startRequestCapture({
        resourceTypes: ["fetch"],
      });
      expect(started).toMatchObject({
        scope: "page",
        baselineCount: 0,
        resourceTypes: ["fetch"],
      });

      await opensteer.goto(`${baseUrl}/phase10/capture`);

      const capture = await opensteer.stopRequestCapture();
      expect(capture.recordCount).toBe(1);

      const record = capture.records[0]!;
      expect(record.method).toBe("POST");
      expect(record.url).toBe(`${baseUrl}/phase10/api/capture?step=load`);
      expect(readHeader(record.requestHeaders, "authorization")).toBe("[redacted]");
      expect(readHeader(record.requestHeaders, "cookie")).toBe("[redacted]");
      expect(readHeader(record.requestHeaders, "x-csrf-token")).toBe("csrf-visible");
      expect(readHeader(record.responseHeaders, "set-cookie")).toBe("[redacted]");
      expect(decodeBody(record.requestBody)).toContain('"hello":"capture"');

      const root = await createFilesystemOpensteerRoot({
        rootPath: path.join(rootDir, ".opensteer"),
      });
      const storedArtifact = await root.artifacts.read(capture.artifactId);
      expect(storedArtifact?.payload).toMatchObject({
        kind: "network-records",
        payloadType: "structured",
      });
      if (storedArtifact?.payload.kind !== "network-records") {
        throw new Error("expected stored network-records artifact");
      }
      expect(storedArtifact.payload.data).toEqual(capture.records);

      const runIds = await listRunIds(rootDir);
      expect(runIds).toHaveLength(1);
      const traceEntries = await root.traces.listEntries(runIds[0]!);
      const stopTrace = traceEntries.find((entry) => entry.operation === "request-capture.stop");
      expect(stopTrace?.artifacts?.[0]?.artifactId).toBe(capture.artifactId);

      const plan = await opensteer.writeRequestPlan({
        key: "phase10-create-order",
        version: "1.0.0",
        provenance: {
          source: "network-capture",
        },
        payload: buildOrderPlanPayload(baseUrl),
      });
      expect(plan.payload.endpoint.method).toBe("POST");

      const listed = await opensteer.listRequestPlans();
      expect(listed.plans.map((entry) => entry.key)).toContain("phase10-create-order");

      const executed = await opensteer.request("phase10-create-order", {
        params: {
          userId: "u_sdk",
        },
        query: {
          debug: true,
        },
        headers: {
          csrf: "csrf-sdk",
        },
        body: {
          json: {
            item: "widget-99",
            quantity: 3,
          },
        },
      });

      expect(executed.data).toMatchObject({
        userId: "u_sdk",
        cookie: expect.stringContaining("phase10-session=abc123"),
        csrf: "csrf-sdk",
        staticHeader: "static",
        page: "1",
        debug: "true",
        body: {
          item: "widget-99",
          quantity: 3,
        },
      });
      expect(executed.request.method).toBe("POST");
      expect(executed.request.url).toBe(`${baseUrl}/phase10/api/users/u_sdk/orders?page=1&debug=true`);

      const refreshed = await opensteer.getRequestPlan({
        key: "phase10-create-order",
      });
      expect(refreshed.freshness?.lastValidatedAt).toEqual(expect.any(Number));

      await opensteer.writeRequestPlan({
        key: "phase10-create-order-invalid",
        version: "1.0.0",
        payload: {
          ...buildOrderPlanPayload(baseUrl),
          response: {
            status: 201,
            contentType: "application/json",
          },
        },
      });

      await expect(
        opensteer.request("phase10-create-order-invalid", {
          params: {
            userId: "u_sdk",
          },
          headers: {
            csrf: "csrf-sdk",
          },
          body: {
            json: {
              item: "broken",
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringMatching(/expected status 201/),
      });

      const invalidPlan = await opensteer.getRequestPlan({
        key: "phase10-create-order-invalid",
      });
      expect(invalidPlan.freshness).toBeUndefined();
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
        execArgv: process.execArgv,
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

  test("CLI exposes capture, plan, and request workflows with file-based payloads", async () => {
    const rootDir = await createPhase6TemporaryRoot();
    const baseUrl = requireFixtureServer().url;
    const sessionName = "phase10-cli";
    const captureOutputPath = path.join(rootDir, "phase10-capture.json");
    const planPayloadPath = path.join(rootDir, "phase10-plan.json");
    const requestBodyPath = path.join(rootDir, "phase10-body.json");
    const requestOutputPath = path.join(rootDir, "phase10-response.json");

    await runCliCommand(rootDir, [
      "open",
      `${baseUrl}/phase10/session`,
      "--name",
      sessionName,
      "--headless",
      "true",
    ]);

    await runCliCommand(rootDir, [
      "capture",
      "start",
      "--name",
      sessionName,
      "--types",
      "fetch",
    ]);
    await runCliCommand(rootDir, ["goto", `${baseUrl}/phase10/capture`, "--name", sessionName]);
    await runCliCommand(rootDir, [
      "capture",
      "stop",
      "--name",
      sessionName,
      "--output",
      captureOutputPath,
    ]);

    const capture = JSON.parse(await readFile(captureOutputPath, "utf8")) as {
      readonly recordCount: number;
      readonly records: readonly NetworkRecord[];
    };
    expect(capture.recordCount).toBe(1);
    expect(readHeader(capture.records[0]!.requestHeaders, "authorization")).toBe("[redacted]");

    await writeFile(planPayloadPath, `${JSON.stringify(buildOrderPlanPayload(baseUrl))}\n`, "utf8");
    await runCliCommand(rootDir, [
      "plan",
      "write",
      "--name",
      sessionName,
      "--key",
      "phase10-cli-order",
      "--version",
      "1.0.0",
      "--payload-file",
      planPayloadPath,
      "--provenance-source",
      "network-capture",
    ]);

    const listed = (await runCliCommand(rootDir, [
      "plan",
      "list",
      "--name",
      sessionName,
    ])) as {
      readonly plans: readonly { readonly key: string }[];
    };
    expect(listed.plans.map((entry) => entry.key)).toContain("phase10-cli-order");

    const storedPlan = (await runCliCommand(rootDir, [
      "plan",
      "get",
      "phase10-cli-order",
      "--name",
      sessionName,
    ])) as {
      readonly payload: {
        readonly endpoint: {
          readonly method: string;
        };
      };
    };
    expect(storedPlan.payload.endpoint.method).toBe("POST");

    await writeFile(
      requestBodyPath,
      `${JSON.stringify({ item: "cli-widget", quantity: 4 })}\n`,
      "utf8",
    );
    await runCliCommand(rootDir, [
      "request",
      "phase10-cli-order",
      "--name",
      sessionName,
      "--param",
      "userId=u_cli",
      "--query",
      "debug=1",
      "--header",
      "csrf=csrf-cli",
      "--body-file",
      requestBodyPath,
      "--output",
      requestOutputPath,
    ]);

    const response = JSON.parse(await readFile(requestOutputPath, "utf8")) as {
      readonly data: Record<string, unknown>;
    };
    expect(response.data).toMatchObject({
      userId: "u_cli",
      cookie: expect.stringContaining("phase10-session=abc123"),
      csrf: "csrf-cli",
      staticHeader: "static",
      page: "1",
      debug: "1",
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
  const { stdout, stderr } = await execFile(process.execPath, [CLI_SCRIPT, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
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
