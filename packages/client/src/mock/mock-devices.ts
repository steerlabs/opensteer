import { RequestSchema, type Request } from "@opensteer/core";
import {
  ComputerAppSetupRequestSchema,
  type ComputerAppSetupRequest,
  type PluginDeviceKind,
} from "@opensteer/integration-core";
import { mockMessagesRunnerId } from "./mock-integration-fixtures.js";

/**
 * Devices that run no Opensteer, each reached through a plugin an agent built,
 * covering every state Settings > Devices shows: one waiting on the person in
 * its setup task, one waiting for its server's approval, one whose computer is
 * offline, and ones that work.
 */
export interface MockDevicePlugin {
  readonly id: string;
  readonly name: string;
  readonly kind: PluginDeviceKind;
  readonly runnerId: string;
  issue: string | null;
  readonly setupThreadId: string | null;
}

const studioImacRunnerId = "rnr_44444444-4444-4444-8444-444444444444";
export const mockTvThreadId = "thr_00000000-0000-4000-8000-0000000000d1";
export const mockLightsThreadId = "thr_00000000-0000-4000-8000-0000000000d2";
export const mockTvRunId = "run_00000000-0000-4000-8000-0000000000d1";
export const mockLightsRunId = "run_00000000-0000-4000-8000-0000000000d2";
const lightsServerId = "isv_0192f4a1-dddd-4000-8000-0000000000d2";

export function mockDevicePlugins(): MockDevicePlugin[] {
  return [
    {
      id: "living-room-tv",
      name: "Living room TV",
      kind: "tv",
      runnerId: mockMessagesRunnerId,
      issue: null,
      setupThreadId: mockTvThreadId,
    },
    {
      id: "desk-lights",
      name: "Desk lights",
      kind: "light",
      runnerId: mockMessagesRunnerId,
      issue: "Waiting for approval",
      setupThreadId: mockLightsThreadId,
    },
    {
      id: "kitchen-speaker",
      name: "Kitchen speaker",
      kind: "speaker",
      runnerId: mockMessagesRunnerId,
      issue: null,
      setupThreadId: null,
    },
    {
      id: "porch-camera",
      name: "Porch camera",
      kind: "camera",
      runnerId: studioImacRunnerId,
      issue: null,
      setupThreadId: null,
    },
    {
      id: "robot-vacuum",
      name: "Robot vacuum",
      kind: "other",
      runnerId: mockMessagesRunnerId,
      issue: null,
      setupThreadId: null,
    },
  ];
}

/** The two setup tasks, as a person started them. */
export const mockDeviceTasks = [
  {
    threadId: mockTvThreadId,
    runId: mockTvRunId,
    messageId: "msg_00000000-0000-4000-8000-0000000000d1",
    title: "Connect the living room TV",
    body: "Connect my living room TV so you can turn it on and open apps.",
    at: "2026-08-09T11:00:00.000Z",
  },
  {
    threadId: mockLightsThreadId,
    runId: mockLightsRunId,
    messageId: "msg_00000000-0000-4000-8000-0000000000d2",
    title: "Connect the desk lights",
    body: "Connect my WiZ desk lights.",
    at: "2026-08-09T11:20:00.000Z",
  },
] as const;

/** The TV's server asking for the code on screen; only that server receives it. */
export function mockTvPairingRequest(userId: string): Request {
  return RequestSchema.parse({
    callId: "mock-living-room-tv-pairing",
    cancellationReason: null,
    createdAt: "2026-08-09T11:02:00.000Z",
    id: "req_0192f4a1-dddd-4000-8000-0000000000d1",
    kind: "integration.input",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: mockTvRunId,
    originatingThreadId: mockTvThreadId,

    payload: {
      installationId: "iin_0192f4a1-dddd-4000-8000-0000000000d1",
      kind: "integration.input",
      serverId: "isv_0192f4a1-dddd-4000-8000-0000000000d1",
    },
    presentation: {
      detail: "Enter the code your TV shows.",
      fields: [{ id: "code", label: "Pairing code", prompt: "Code on the TV", secret: true }],
      kind: "form",
      title: "Pair with Living room TV",
    },
    requestedBy: userId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  });
}

/** The lights' server, which the lights task installed, waiting for Mac mini's owner to let it run. */
export function mockLightsServerSetup(userId: string, now: Date): ComputerAppSetupRequest {
  return ComputerAppSetupRequestSchema.parse({
    access: "read-write",
    app: null,
    createdAt: now.toISOString(),
    definitionDigest: "mock-desk-lights",
    definitionId: lightsServerId,
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(),
    id: "0192f4a1-dddd-4000-8000-0000000000d2",
    kind: "server",
    ownerUserId: userId,
    policyAppApproval: null,
    reason: "Turn the desk lights on and off, and set their color.",
    runnerId: mockMessagesRunnerId,
    server: {
      installationTitle: "Desk lights",
      name: "desk-lights",
      serverId: lightsServerId,
      launch: {
        args: ["server.js"],
        command: "node",
        cwd: "/Users/alex/Opensteer/plugins/desk-lights",
        env: {},
        pluginId: "desk-lights",
        type: "stdio",
      },
    },
    threadId: mockLightsThreadId,
    threadTitle: "Connect the desk lights",
  });
}

export function mockDeviceAccessRequest(userId: string): Request {
  const template = mockTvPairingRequest(userId);
  return RequestSchema.parse({
    ...template,
    id: "req_0192f4a1-dddd-4000-8000-0000000000d3",
    callId: "mock-device-access",
    kind: "device.access",
    payload: {
      kind: "device.access",
      machineId: "rnr_33333333-3333-4333-8333-333333333333",
      machineName: "Alex’s MacBook Pro",
      access: "apps",
      reason: "Check the new build in Simulator on this Mac.",
    },
    presentation: {
      kind: "external",
      subject: { kind: "device.access", id: "rnr_33333333-3333-4333-8333-333333333333" },
      title: "Let your agent use Apps on Alex’s MacBook Pro?",
      detail:
        "Check the new build in Simulator on this Mac. Per-app, browser profile and macOS permissions may still be needed.",
    },
    requiredActor: "owner",
  });
}
