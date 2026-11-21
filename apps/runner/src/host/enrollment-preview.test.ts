import { parseRunnerConfig } from "@opensteer/config";
import { createId } from "@opensteer/core";
import {
  deviceEnrollmentPreviewPath,
  RunnerBootIdSchema,
  RunnerToHostMessageSchema,
  runnerProofFormatVersion,
  workHomeEnrollmentPreviewRequiredReason,
} from "@opensteer/protocol";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { WorkHomeEnrollmentRefused } from "./enrollment-preview.js";
import { ReconnectingHostConnection } from "./host-connection.js";

const token = "t".repeat(32);
const previewFailed = "Couldn’t check what this Home shares. Try again.";
const previewRequired = "Read what this work Home shares first, then try again.";

describe("Runner enrollment preview", () => {
  it.each([
    {
      label: "allowed work Home",
      body: { organizationName: "Northwind", devices: "assignee-may-enroll" },
      notice:
        "This device is joining a work Home owned by Northwind. Northwind will see that it joined, never what's on it.",
    },
    {
      label: "restricted work Home",
      body: { organizationName: "Northwind", devices: "cloud-computer-only" },
      refusal: "Northwind doesn't allow other devices to join this work Home.",
    },
    { label: "personal Home", body: {} },
    { label: "Home requires preview again", body: {}, enrollmentRefusal: previewRequired },
    { label: "older Home", status: 404 },
    { label: "invalid token", status: 403, refusal: previewFailed },
    { label: "unreachable preview", drop: true, refusal: previewFailed },
    { label: "rate-limited preview", status: 429, refusal: previewFailed },
    { label: "temporarily unavailable preview", status: 503, refusal: previewFailed },
    {
      label: "invalid preview",
      body: { organizationName: "Northwind", devices: "unknown" },
      refusal: previewFailed,
    },
    {
      label: "incomplete preview",
      body: { organizationName: "Northwind" },
      refusal: previewFailed,
    },
    { label: "redirecting preview", status: 307, refusal: previewFailed },
    { label: "hosting Runner", runnerKind: "main" },
    { label: "managed service", runnerKind: "managed" },
    {
      label: "persisted identity",
      enrolled: true,
      body: { organizationName: "Northwind", devices: "cloud-computer-only" },
    },
  ])("$label", async (preview) => {
    const actions: string[] = [];
    const requests: { url: string | undefined; method: string | undefined; body: unknown }[] = [];
    const abort = new AbortController();
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ url: request.url, method: request.method, body: body && JSON.parse(body) });
        actions.push("preview");
        if (preview.drop) {
          response.destroy();
          return;
        }
        response.writeHead(preview.status ?? 200, {
          "content-type": "application/json",
          ...(preview.status === 307 ? { location: "/redirected" } : {}),
        });
        response.end(JSON.stringify(preview.body ?? {}));
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const webSockets = new WebSocketServer({ path: "/internal/v1/runners", server });
    webSockets.on("connection", (socket) => {
      actions.push("opened socket");
      socket.send(
        JSON.stringify({
          challengeId: `rch_${randomUUID()}`,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          hostSessionId: randomUUID(),
          nonce: randomUUID(),
          proofFormatVersion: runnerProofFormatVersion,
          runEventsVersion: 2,
          type: "host.challenge",
        }),
      );
      socket.once("message", (raw) => {
        const proof = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString()));
        actions.push(proof.type);
        if (preview.enrollmentRefusal) {
          socket.send(
            JSON.stringify({
              type: "host.error",
              error: {
                code: "forbidden",
                reason: workHomeEnrollmentPreviewRequiredReason,
                message: preview.enrollmentRefusal,
                retryable: false,
              },
            }),
          );
          socket.close(4003);
        } else abort.abort();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const config = parseRunnerConfig({
        OPENSTEER_HOST_URL: `http://127.0.0.1:${address.port}`,
        OPENSTEER_RUNNER_ENROLLMENT_TOKEN: token,
        OPENSTEER_RUNNER_KIND: preview.runnerKind ?? "local",
        OPENSTEER_RUNNER_MODULES: "shell",
      });
      const pair = generateKeyPairSync("ed25519");
      const identity = {
        ...pair,
        publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
        runnerId: createId("runner"),
        environmentId: null,
        createdAt: new Date().toISOString(),
        lastConnectionGeneration: preview.enrolled ? 1 : 0,
        version: 3 as const,
      };
      const connection = new ReconnectingHostConnection({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        config,
        enrollmentNotice: (message) => actions.push(message),
        identity,
        identityStore: { acceptHostConnection: async () => identity },
        logger: { info: () => undefined, error: () => undefined },
        runtimeVersion: "test",
        shellModule: {
          descriptor: {
            platform: "linux",
            hostPublicKey:
              "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
          },
          helperBinary: process.execPath,
          hostKeyPath: "/unused",
        },
      });
      if (preview.refusal) {
        const result = connection.run(abort.signal);
        await expect(result).rejects.toBeInstanceOf(WorkHomeEnrollmentRefused);
        await expect(result).rejects.toThrow(preview.refusal);
        expect(actions).toEqual(["preview"]);
      } else if (preview.enrollmentRefusal) {
        await expect(connection.run(abort.signal)).rejects.toThrow(preview.enrollmentRefusal);
        expect(actions).toEqual(["preview", "opened socket", "runner.enroll"]);
      } else {
        await connection.run(abort.signal);
        expect(actions).toEqual(
          preview.enrolled
            ? ["opened socket", "runner.authenticate"]
            : [
                ...(preview.runnerKind ? [] : ["preview"]),
                ...(preview.notice ? [preview.notice] : []),
                "opened socket",
                "runner.enroll",
              ],
        );
      }
      expect(requests).toEqual(
        preview.enrolled || preview.runnerKind
          ? []
          : [
              {
                url: deviceEnrollmentPreviewPath,
                method: "POST",
                body: { enrollmentToken: token },
              },
            ],
      );
    } finally {
      abort.abort();
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
