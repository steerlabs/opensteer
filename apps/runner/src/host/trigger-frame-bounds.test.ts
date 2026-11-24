import {
  MAX_AUTOMATION_SECRETS_TOTAL_BYTES,
  MAX_SCRIPT_BYTES,
  MAX_WEBHOOK_BODY_BYTES,
} from "@opensteer/triggers";
import { describe, expect, it } from "vitest";
import { runnerControlMaxFrameBytes } from "./host-connection.js";

describe("Runner control frame bounds for automation scripts (AA14.6)", () => {
  it("fits a worst-case JSON-escaped trigger.execute frame (256 KiB script + 256 KiB body + 64 KiB secrets)", () => {
    // Control bytes (\u0000) expand 6x under JSON.stringify; binary body expands 4/3 under base64.
    const worstCaseScript = "\u0000".repeat(MAX_SCRIPT_BYTES);
    const worstCaseBodyBase64 = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES, 0xff).toString("base64");
    const worstCaseSecrets = {
      BIG_SECRET: "\u0000".repeat(MAX_AUTOMATION_SECRETS_TOTAL_BYTES - 10),
    };
    const frame = {
      command: {
        commandId: "cmd_00000000-0000-4000-8000-000000000001",
        context: {
          agentHome: {
            computerId: "rnr_00000000-0000-4000-8000-000000000001",
            path: "/home/agent",
          },
          anchorThreadId: "thr_00000000-0000-4000-8000-000000000001",
          browserCdp: { token: "t".repeat(512), url: "wss://home.example/internal/v1/trigger-cdp" },
          event: {
            id: "toc_00000000-0000-4000-8000-000000000001",
            payload: null,
            receivedAt: "2026-11-23T00:00:00.000Z",
            source: {
              bodyBytes: MAX_WEBHOOK_BODY_BYTES,
              headers: {
                "content-type": "application/octet-stream",
                "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
              },
              kind: "webhook",
              method: "POST",
              path: "/hooks/v1",
              query: { a: "1" },
            },
            trigger: {
              anchorThreadId: "thr_00000000-0000-4000-8000-000000000001",
              id: "trg_00000000-0000-4000-8000-000000000001",
              revisionId: "trv_00000000-0000-4000-8000-000000000001",
            },
          },
          executionGeneration: 1,
          mcp: { token: "m".repeat(512), url: "https://home.example/mcp" },
          occurrenceId: "toc_00000000-0000-4000-8000-000000000001",
          script: { interpreter: ["/usr/bin/env", "node"], text: worstCaseScript },
          secrets: worstCaseSecrets,
          triggerId: "trg_00000000-0000-4000-8000-000000000001",
          webhookBodyBase64: worstCaseBodyBase64,
        },
        type: "trigger.execute",
      },
      type: "host.command",
    };
    const encodedBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    expect(encodedBytes).toBeGreaterThan(1024 * 1024);
    expect(encodedBytes).toBeLessThanOrEqual(runnerControlMaxFrameBytes);
  });
});
