import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createId } from "@opensteer/core";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import {
  ComputerUseBridgeRequestSchema,
  HostIntegrationsDisplayResolveSchema,
  HostIntegrationsDisplayStartSchema,
  HostIntegrationsDisplayDemandSchema,
  RunnerAuxiliaryFrameFenceSchema,
  DisplaySourceSchema,
  DisplayStreamIdSchema,
  encodeDisplayMediaFrame,
  decodeDisplayMediaFrame,
  macWindowVideoParams,
  HostIntegrationsMacOwnerInputSchema,
  HostIntegrationsMacOwnerInputResetSchema,
  type ComputerUseBridgeRequest,
} from "@opensteer/protocol";
import { ComputerUseBridgeDeadlineError } from "./computer-use-bridge-client.js";
import { ComputerUseHandler } from "./computer-use-handler.js";
import { MacWindowVideoRelay, type MacVideoEvent } from "./mac-window-video-relay.js";

const fence = RunnerAuxiliaryFrameFenceSchema.parse({
  runnerId: createId("runner"),
  bootId: "rbt_00000000-0000-4000-8000-000000000001",
  connectionId: "rcn_00000000-0000-4000-8000-000000000002",
  connectionLeaseId: "rls_00000000-0000-4000-8000-000000000003",
  auxiliaryStreamId: "rax_00000000-0000-4000-8000-000000000004",
  connectionGeneration: 1,
  module: "integrations",
});

const source = DisplaySourceSchema.parse({
  kind: "owner-view",
  viewId: "cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  generation: 1,
});
const streamId = DisplayStreamIdSchema.parse("dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const bindingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const attachmentToken = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

it.each([
  "previous-desktop",
  "previous-helper",
  "current",
  "unsupported",
  "lost",
  "timeout",
  "readiness",
  "warm-readiness",
  "unchanged-readiness",
  "warm-unchanged-readiness",
  "readiness-failed",
  "readiness-revoked",
  "uncached-readiness-revoked",
  "uncached-unchanged-readiness",
  "previous-desktop-unchanged-readiness",
  "previous-helper-unchanged-readiness",
] as const)(
  "negotiates %s before extended resolution and streams passive Mac media",
  async (peer) => {
    const desktop = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let handler: ComputerUseHandler | undefined;
    let relay: MacWindowVideoRelay | undefined;
    const requests: ComputerUseBridgeRequest[] = [];
    const events: MacVideoEvent[] = [];
    const received: Buffer[] = [];
    const credits: unknown[] = [];
    let supported = true;
    let readinessFailed = false;
    let permissionRevoked = false;
    const unchangedReadiness = peer.endsWith("unchanged-readiness");
    const legacy = peer.startsWith("previous-");
    let sendMedia = (_sequence: number) => {};
    let changeReadiness = () => {};
    let ownerEvent = (_source: typeof source) => {};
    const media = encodeDisplayMediaFrame(
      {
        streamId,
        generation: 1,
        sequence: 0,
        ptsUs: 0,
        key: true,
        codec: "avc1.42E01E",
        width: 320,
        height: 240,
      },
      peer === "current"
        ? new Uint8Array(2 * 1_048_576).fill(255)
        : new Uint8Array([0, 0, 0, 1, 101, 255]),
    );
    const oldResolve = z.strictObject({ source: DisplaySourceSchema });
    try {
      await Promise.all([once(desktop, "listening"), once(host, "listening")]);
      const desktopAddress = desktop.address();
      const hostAddress = host.address();
      if (
        !desktopAddress ||
        typeof desktopAddress === "string" ||
        !hostAddress ||
        typeof hostAddress === "string"
      )
        throw Error("Missing test ports");
      desktop.on("connection", (socket, request) => {
        if (request.url?.startsWith("/computer-use/display/")) {
          expect(request.url).toBe(`/computer-use/display/${attachmentToken}`);
          socket.on("message", (raw) => credits.push(JSON.parse(String(raw))));
          sendMedia = (sequence) =>
            socket.send(
              encodeDisplayMediaFrame(
                {
                  ...decodeDisplayMediaFrame(media).header,
                  sequence,
                },
                decodeDisplayMediaFrame(media).payload,
              ),
              { binary: true },
            );
          socket.send(media, { binary: true });
          return;
        }
        ownerEvent = (source) =>
          socket.send(
            JSON.stringify({
              kind: "event",
              event: "display.owner-input",
              params: {
                streamId,
                source,
                message: {
                  type: "display.editing",
                  generation: 1,
                  context: {
                    contextId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    field: null,
                    caret: null,
                  },
                },
              },
            }),
          );
        changeReadiness = () => {
          if (peer === "readiness-failed") readinessFailed = true;
          else if (peer === "readiness-revoked" || peer === "uncached-readiness-revoked")
            permissionRevoked = true;
          else if (!unchangedReadiness) supported = false;
          socket.send(JSON.stringify({ kind: "event", event: "grants.changed" }));
        };
        socket.on("message", (raw) => {
          const frame = ComputerUseBridgeRequestSchema.parse(JSON.parse(String(raw)));
          requests.push(frame);
          const answer = (result: unknown) =>
            socket.send(
              JSON.stringify({
                kind: "response",
                id: frame.id,
                result,
              }),
            );
          if (frame.method === "permissions.get") {
            if (readinessFailed) {
              socket.send(
                JSON.stringify({
                  kind: "response",
                  id: frame.id,
                  error: { code: "failed", message: "Readiness could not be verified" },
                }),
              );
              return;
            }
            answer({
              computerUseVersion: 2,
              ownerViewVersion: 3,
              ...(supported && !legacy && request.headers["x-opensteer-mac-owner-input"] === "2"
                ? { ownerInputVersion: 2 }
                : {}),
              permissions: {
                accessibility: "granted",
                screenRecording: permissionRevoked ? "denied" : "granted",
              },
            });
          } else if (frame.method === "display.resolve") {
            const parsed = (
              peer.startsWith("previous-desktop")
                ? oldResolve
                : macWindowVideoParams["display.resolve"]
            ).safeParse(frame.params);
            if (!parsed.success) {
              socket.send(
                JSON.stringify({
                  kind: "response",
                  id: frame.id,
                  error: { code: "failed", message: "Previous Desktop requires baseline resolve" },
                }),
              );
              return;
            }
            answer({
              target: {
                kind: "mac-window",
                bindingId,
                ...(supported && !legacy ? { editingVersion: 1 } : {}),
              },
            });
          } else if (frame.method === "display.start") answer({ attachmentToken });
          else if (frame.method === "display.input") {
            if (peer === "lost") socket.terminate();
            else
              socket.send(
                JSON.stringify({
                  kind: "response",
                  id: frame.id,
                  error: {
                    code: peer === "timeout" ? "outcome-unknown" : "unsupported",
                    message: "fixture refusal",
                  },
                }),
              );
          } else answer({});
        });
      });
      host.on("connection", (socket) => {
        socket.on("message", (raw, binary) => {
          expect(binary).toBe(true);
          received.push(Buffer.from(raw as Buffer));
          socket.send(
            JSON.stringify({
              type: "display.ack",
              sequence: decodeDisplayMediaFrame(Buffer.from(raw as Buffer)).header.sequence,
            }),
          );
        });
      });
      handler = new ComputerUseHandler({
        bridge: {
          token: "fixture-only",
          url: new URL(`http://127.0.0.1:${desktopAddress.port}/computer-use`),
        },
      });
      relay = new MacWindowVideoRelay(
        handler,
        { hostOrigin: new URL(`http://127.0.0.1:${hostAddress.port}`), mode: "development" },
        async (event) => {
          events.push(event);
        },
      );
      relay.handle(
        HostIntegrationsDisplayResolveSchema.parse({
          ...fence,
          type: "host.integrations.display.resolve",
          requestId: "resolve",
          source,
          ownerInputVersion: 2,
          timeoutMs: 5_000,
        }),
      );
      await expect
        .poll(() => events.find((e) => e.type === "runner.integrations.display.resolved"))
        .toMatchObject({ target: { kind: "mac-window", bindingId } });
      const resolved = events.find(
        (event) => event.type === "runner.integrations.display.resolved",
      );
      expect(resolved?.target).toEqual({
        kind: "mac-window",
        bindingId,
        ...(supported && !legacy ? { editingVersion: 1 } : {}),
      });
      expect(requests.slice(0, 2).map((r) => r.method)).toEqual([
        "permissions.get",
        "display.resolve",
      ]);
      expect(requests.find((r) => r.method === "display.resolve")?.params).toEqual({
        source,
        ...(supported && !legacy ? { ownerInputVersion: 2 } : {}),
      });
      if (peer.startsWith("uncached-")) handler.releaseSessions();
      relay.handle(
        HostIntegrationsDisplayStartSchema.parse({
          ...fence,
          type: "host.integrations.display.start",
          display: "main",
          revision: 0,
          streamId,
          target: { kind: "mac-window", bindingId },
          sources: [source],
          maxLongSide: 1280,
          maxFps: 30,
          timeoutMs: 5_000,
          dataTicket: "fixture.ticket.value",
        }),
      );
      await expect.poll(() => received.length).toBe(1);
      expect(received[0]?.equals(Buffer.from(media))).toBe(true);
      await expect.poll(() => credits).toEqual([{ type: "display.ack", sequence: 0 }]);
      if (peer.startsWith("uncached-")) expect(handler.ownerViewVersion()).toBeUndefined();
      if (peer === "current") {
        const otherSource = DisplaySourceSchema.parse({
          kind: "owner-view",
          viewId: "cvw_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          generation: 1,
        });
        ownerEvent(otherSource);
        ownerEvent(source);
        await expect
          .poll(() =>
            events.filter((event) => event.type === "runner.integrations.mac-owner.event"),
          )
          .toHaveLength(1);
        expect(
          events.find((event) => event.type === "runner.integrations.mac-owner.event"),
        ).toMatchObject({ source });
        relay.handle(
          HostIntegrationsMacOwnerInputSchema.parse({
            ...fence,
            type: "host.integrations.mac-owner.input",
            streamId,
            source: otherSource,
            geometry: 1,
            sequence: 0,
            events: [{ kind: "copy" }],
          }),
        );
        relay.handle(
          HostIntegrationsMacOwnerInputResetSchema.parse({
            ...fence,
            type: "host.integrations.mac-owner.input-reset",
            streamId,
            source,
          }),
        );
        await expect
          .poll(() => requests.filter((request) => request.method === "display.input-reset"))
          .toHaveLength(1);
        expect(requests.filter((request) => request.method === "display.input")).toHaveLength(0);
      }
      if (["unsupported", "lost", "timeout"].includes(peer)) {
        if (peer === "timeout")
          vi.spyOn(handler, "videoRequest").mockRejectedValueOnce(
            new ComputerUseBridgeDeadlineError("display.input", true),
          );
        relay.handle(
          HostIntegrationsMacOwnerInputSchema.parse({
            ...fence,
            type: "host.integrations.mac-owner.input",
            streamId,
            source,
            sequence: 0,
            geometry: 1,
            events: [{ kind: "copy" }],
          }),
        );
        await expect
          .poll(() =>
            events.find(
              (event) =>
                event.type === "runner.integrations.mac-owner.event" &&
                event.message.type === "display.input.result",
            ),
          )
          .toMatchObject({
            message: {
              outcome: "refused",
              reason: peer === "unsupported" ? "unsupported" : "unavailable",
            },
          });
      }
      if (unchangedReadiness || peer === "readiness-failed") {
        if (peer === "warm-unchanged-readiness")
          relay.handle(
            HostIntegrationsDisplayDemandSchema.parse({
              ...fence,
              type: "host.integrations.display.demand",
              display: "main",
              streamId,
              revision: 1,
              sources: [],
              warm: { sources: [source], durationMs: 1000 },
            }),
          );
        const reads = () => requests.filter(({ method }) => method === "permissions.get").length;
        const repeats = peer === "unchanged-readiness" ? 10 : 1;
        for (let index = 0; index < repeats; index++) {
          const before = reads();
          changeReadiness();
          await vi.waitFor(() =>
            expect(reads(), "A grants hint must revalidate active or warm media").toBeGreaterThan(
              before,
            ),
          );
          if (peer === "readiness-failed") {
            await vi.waitFor(() =>
              expect(
                events.some((event) => event.type === "runner.integrations.display.source-changed"),
              ).toBe(true),
            );
            await vi.waitFor(() =>
              expect(requests.some(({ method }) => method === "display.stop")).toBe(true),
            );
          } else {
            await handler.permissions();
            sendMedia(index + 1);
            await vi.waitFor(() =>
              expect(received, "The same media attachment must carry the next frame").toHaveLength(
                index + 2,
              ),
            );
            expect(
              events.filter((event) => event.type === "runner.integrations.display.source-changed"),
            ).toEqual([]);
            expect(requests.filter(({ method }) => method === "display.stop")).toEqual([]);
            expect(requests.filter(({ method }) => method === "display.start")).toHaveLength(1);
          }
        }
      }
      if (peer === "lost") {
        expect(
          events.some((event) => event.type === "runner.integrations.display.source-changed"),
        ).toBe(true);
      }
      if (peer === "readiness-revoked" || peer === "uncached-readiness-revoked") {
        changeReadiness();
        await vi.waitFor(() =>
          expect(
            events.some((event) => event.type === "runner.integrations.display.source-changed"),
          ).toBe(true),
        );
        await vi.waitFor(() =>
          expect(requests.some(({ method }) => method === "display.stop")).toBe(true),
        );
      }
      if (peer === "readiness" || peer === "warm-readiness") {
        if (peer === "warm-readiness")
          relay.handle(
            HostIntegrationsDisplayDemandSchema.parse({
              ...fence,
              type: "host.integrations.display.demand",
              display: "main",
              streamId,
              revision: 1,
              sources: [],
              warm: { sources: [source], durationMs: 1000 },
            }),
          );
        changeReadiness();
        await expect
          .poll(() =>
            events.some(
              (event) =>
                event.type === "runner.integrations.display.source-changed" &&
                event.source.kind === "owner-view",
            ),
          )
          .toBe(true);
        relay.handle(
          HostIntegrationsDisplayResolveSchema.parse({
            ...fence,
            type: "host.integrations.display.resolve",
            requestId: "after-readiness-loss",
            source,
            ownerInputVersion: 2,
            timeoutMs: 5_000,
          }),
        );
        await expect
          .poll(() =>
            events.find(
              (event) =>
                event.type === "runner.integrations.display.resolved" &&
                event.requestId === "after-readiness-loss",
            ),
          )
          .toMatchObject({ target: { kind: "mac-window", bindingId } });
        const baseline = events.find(
          (event) =>
            event.type === "runner.integrations.display.resolved" &&
            event.requestId === "after-readiness-loss",
        );
        expect(
          baseline?.type === "runner.integrations.display.resolved" ? baseline.target : null,
        ).toEqual({ kind: "mac-window", bindingId });
      }
      const out =
        process.env.OPENSTEER_MAC_BRIDGE_COMPAT_ARTIFACT_DIR ??
        (await mkdtemp(path.join(tmpdir(), "opensteer-mac-bridge-compat-")));
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(out, `${peer}.json`),
        JSON.stringify(
          {
            peer,
            passed: true,
            requests,
            events,
            exactMediaBytes: received[0]?.length,
            credits,
            boundary: "real Runner and loopback sockets; previous Desktop strict resolve schema",
          },
          null,
          2,
        ),
      );
      console.info(`Mac bridge compatibility evidence: ${out}/${peer}.json`);
    } finally {
      relay?.close();
      handler?.close();
      for (const server of [desktop, host]) {
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);
