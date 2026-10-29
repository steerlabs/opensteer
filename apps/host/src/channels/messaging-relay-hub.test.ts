import { slackChannelProviderManifest } from "@opensteer/channel-core";
import { RunnerIdSchema } from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
  RunnerAuxiliaryFrameFenceSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { MessagingRelayHub, type MessagingRelayPeer } from "./messaging-relay-hub.js";

describe("MessagingRelayHub", () => {
  it("retains a flapped assignment through the renewed auxiliary lease", () => {
    let now = Date.parse("2026-09-12T12:00:00.000Z");
    const hub = new MessagingRelayHub({ now: () => now });
    const peer: MessagingRelayPeer = {
      close: vi.fn(),
      id: "peer-1",
      send: vi.fn(async () => undefined),
    };
    const initial = stream(new Date(now + 1_000).toISOString());
    hub.attach(peer, initial);
    hub.renew(peer, stream(new Date(now + 60_000).toISOString()));
    now += 2_000;

    hub.detach(peer, "transport-disconnected");

    expect(hub.assignableRunnerIds()).toEqual([initial.identity.runnerId]);
  });
});

function stream(streamLeaseExpiresAt: string): RunnerAuxiliaryStream {
  const runnerId = RunnerIdSchema.parse("rnr_11111111-1111-4111-8111-111111111111");
  const bootId = RunnerBootIdSchema.parse("rbt_11111111-1111-4111-8111-111111111111");
  const connectionId = RunnerConnectionIdSchema.parse("rcn_11111111-1111-4111-8111-111111111111");
  const connectionLeaseId = RunnerConnectionLeaseIdSchema.parse(
    "rls_11111111-1111-4111-8111-111111111111",
  );
  const fence = RunnerAuxiliaryFrameFenceSchema.parse({
    auxiliaryStreamId: "rax_11111111-1111-4111-8111-111111111111",
    bootId,
    connectionGeneration: 1,
    connectionId,
    connectionLeaseId,
    module: "messaging",
    runnerId,
  });
  return {
    auxiliaryStreamId: fence.auxiliaryStreamId,
    fence,
    identity: {
      allowedModules: ["messaging"],
      bootId,
      capabilities: [],
      connectionGeneration: 1,
      personalRemoteAccessGeneration: null,
      connectionId,
      connectionLeaseId,
      environmentIds: [],
      fence,
      modules: {
        messaging: {
          capabilities: [
            {
              manifest: slackChannelProviderManifest,
              provider: "slack",
              transportKinds: ["socket"],
            },
          ],
        },
      },
      name: "Messaging service",
      runnerId,
      runnerKind: "managed",
      runtimeVersion: "test",
    },
    streamLeaseExpiresAt,
  };
}
