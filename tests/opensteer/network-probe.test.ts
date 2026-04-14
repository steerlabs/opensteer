import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { createFakeBrowserCoreEngine } from "../../packages/browser-core/src/index.js";
import { OpensteerSessionRuntime } from "../../packages/opensteer/src/sdk/runtime.js";
import {
  createFilesystemOpensteerWorkspace,
  runWithPolicyTimeout,
} from "../../packages/opensteer/src/index.js";

const temporaryRoots: string[] = [];

type ReplayAttemptTimeout = {
  readonly signal: AbortSignal;
  throwIfAborted(): void;
};

type RuntimeProbeTimeout = {
  readonly operation: string;
  readonly signal: AbortSignal;
  remainingMs(): number | undefined;
  throwIfAborted(): void;
};

type NetworkProbeRuntime = OpensteerSessionRuntime & {
  executeReplayTransportAttempt: (
    transport: string,
    request: unknown,
    timeout: ReplayAttemptTimeout,
  ) => Promise<{
    readonly request: {
      readonly method: string;
      readonly url: string;
    };
    readonly response: {
      readonly status: number;
      readonly statusText: string;
      readonly url: string;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
      readonly redirected: boolean;
      readonly body?: {
        readonly data: string;
        readonly encoding: "base64";
        readonly mimeType: string;
        readonly truncated: false;
        readonly originalByteLength: number;
        readonly capturedByteLength: number;
      };
    };
  }>;
  probeTransportsForRecord: (
    record: ReturnType<typeof createCapturedRecord>,
    timeout: RuntimeProbeTimeout,
  ) => Promise<
    | {
        readonly recommended?: string;
        readonly attempts: readonly {
          readonly transport: string;
          readonly ok: boolean;
          readonly error?: string;
        }[];
      }
    | undefined
  >;
};

describe("network detail probe", () => {
  afterAll(async () => {
    await Promise.all(
      temporaryRoots.map((rootPath) =>
        rm(rootPath, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  test("caps individual transport probes so later transports still run", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-network-probe-"));
    temporaryRoots.push(rootDir);

    const runtime = new OpensteerSessionRuntime({
      name: "network-probe-budget",
      rootDir,
      engine: createFakeBrowserCoreEngine(),
    });
    const runtimeInternal = runtime as NetworkProbeRuntime;
    const originalExecuteReplayTransportAttempt = runtimeInternal.executeReplayTransportAttempt;

    runtimeInternal.executeReplayTransportAttempt = async (transport, _request, timeout) => {
      if (transport === "direct-http") {
        await delayWithSignal(timeout.signal, 40);
        timeout.throwIfAborted();
      }
      return {
        request: {
          method: "POST",
          url: "https://example.com/graphql",
        },
        response: createJsonResponse(
          200,
          transport === "matched-tls"
            ? {
                data: {
                  search: ["ok"],
                },
              }
            : {
                data: {
                  search: ["mismatch"],
                },
              },
        ),
      };
    };

    try {
      const result = await runWithPolicyTimeout(
        {
          resolveTimeoutMs() {
            return 45;
          },
        },
        {
          operation: "network.detail",
        },
        (timeout) => runtimeInternal.probeTransportsForRecord(createCapturedRecord(), timeout),
      );

      expect(result).toBeDefined();
      expect(result?.recommended).toBe("matched-tls");
      expect(result?.attempts.map((attempt) => attempt.transport)).toContain("matched-tls");
      expect(result?.attempts.find((attempt) => attempt.transport === "matched-tls")).toMatchObject(
        {
          ok: true,
        },
      );
      expect(result?.attempts.find((attempt) => attempt.transport === "direct-http")).toMatchObject(
        {
          ok: false,
          error: expect.stringContaining("direct-http probe exceeded"),
        },
      );
    } finally {
      runtimeInternal.executeReplayTransportAttempt = originalExecuteReplayTransportAttempt;
      await runtime.disconnect().catch(() => undefined);
    }
  });

  test("returns network detail for status-less records without trace serialization failures", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "opensteer-network-detail-"));
    temporaryRoots.push(rootDir);

    const workspace = await createFilesystemOpensteerWorkspace({ rootPath: rootDir });
    await workspace.registry.savedNetwork.save(
      [
        {
          recordId: "record:statusless",
          savedAt: Date.now(),
          record: {
            kind: "http",
            requestId: "request:statusless",
            sessionRef: "session:statusless",
            pageRef: "page:statusless",
            method: "GET",
            url: "https://example.com/api/stream",
            requestHeaders: [],
            responseHeaders: [],
            resourceType: "fetch",
            navigationRequest: false,
            captureState: "complete",
            requestBodyState: "skipped",
            responseBodyState: "skipped",
          },
        },
      ],
      {
        bodyWriteMode: "authoritative",
      },
    );

    const runtime = new OpensteerSessionRuntime({
      name: "statusless-detail",
      rootPath: rootDir,
      engine: createFakeBrowserCoreEngine(),
      cleanupRootOnClose: false,
    });

    try {
      await expect(runtime.getNetworkDetail({ recordId: "statusless" })).resolves.toMatchObject({
        summary: {
          method: "GET",
          url: "https://example.com/api/stream",
        },
      });
    } finally {
      await runtime.disconnect().catch(() => undefined);
    }
  });
});

function createCapturedRecord() {
  return {
    recordId: "record:test",
    savedAt: Date.now(),
    record: {
      kind: "http",
      requestId: "request:test",
      sessionRef: "session:test",
      method: "POST",
      status: 200,
      url: "https://example.com/graphql",
      resourceType: "fetch",
      requestHeaders: [
        {
          name: "content-type",
          value: "application/json",
        },
      ],
      responseHeaders: [
        {
          name: "content-type",
          value: "application/json",
        },
      ],
      requestBody: createJsonProtocolBody({
        operationName: "SearchQuery",
        variables: {
          q: "opensteer",
        },
      }),
      responseBody: createJsonProtocolBody({
        data: {
          search: ["ok"],
        },
      }),
    },
  } as const;
}

function createJsonResponse(status: number, value: unknown) {
  return {
    status,
    statusText: "OK",
    url: "https://example.com/graphql",
    headers: [
      {
        name: "content-type",
        value: "application/json",
      },
    ],
    redirected: false,
    body: createJsonProtocolBody(value),
  } as const;
}

function createJsonProtocolBody(value: unknown) {
  const json = JSON.stringify(value);
  const byteLength = Buffer.byteLength(json);
  return {
    data: Buffer.from(json, "utf8").toString("base64"),
    encoding: "base64" as const,
    mimeType: "application/json",
    truncated: false as const,
    originalByteLength: byteLength,
    capturedByteLength: byteLength,
  };
}

async function delayWithSignal(signal: AbortSignal, durationMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
