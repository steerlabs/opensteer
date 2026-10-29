import {
  IntegrationsModuleEventSchema,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  type ComputerUsePermissions,
  type IntegrationsModuleEvent,
} from "@opensteer/protocol";
import { createId } from "@opensteer/core";
import type { RunnerModuleStream } from "@opensteer/runner-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computerUseAccessibilitySentence,
  computerUseScreenRecordingSentence,
  createMacosAppProvider,
} from "./macos-app-provider.js";
import { ComputerAppModuleHandler } from "./module-handler.js";
import type { ComputerAppOperationInspection } from "./provider.js";

const granted: ComputerUsePermissions = { accessibility: "granted", screenRecording: "granted" };

const handlers: ComputerAppModuleHandler[] = [];

afterEach(() => {
  for (const handler of handlers.splice(0)) handler.detach();
  vi.useRealTimers();
});

describe("the computer use status entry", () => {
  it("maps each state of the two grants", async () => {
    // Both operations need both grants, because `act` ends by observing, so
    // neither is ever reported readier than the other.
    expect(await inspectWith(granted)).toEqual([
      { detail: null, operation: "observe", remedy: null, state: "ready" },
      { detail: null, operation: "act", remedy: null, state: "ready" },
    ]);
    // One grant missing: one switch to throw, and both rows name it.
    expect(await inspectWith({ accessibility: "granted", screenRecording: "denied" })).toEqual([
      { ...screenRecordingRequired, operation: "observe" },
      { ...screenRecordingRequired, operation: "act" },
    ]);
    expect(await inspectWith({ accessibility: "denied", screenRecording: "granted" })).toEqual([
      { ...accessibilityRequired, operation: "observe" },
      { ...accessibilityRequired, operation: "act" },
    ]);
    // Neither grant: each row names the grant its own work needs first, so the
    // Host sees both switches at once instead of the second only after the
    // first is on.
    expect(await inspectWith({ accessibility: "denied", screenRecording: "denied" })).toEqual([
      { ...screenRecordingRequired, operation: "observe" },
      { ...accessibilityRequired, operation: "act" },
    ]);
  });

  it("reports an unexpected probe failure without exposing internal error details", async () => {
    const provider = createMacosAppProvider({
      permissions: () => Promise.reject(new Error("internal probe failure")),
    });
    expect(await provider.inspect()).toEqual([
      {
        detail: "Computer use could not read its macOS permissions.",
        operation: "observe",
        remedy: null,
        state: "unavailable",
      },
      {
        detail: "Computer use could not read its macOS permissions.",
        operation: "act",
        remedy: null,
        state: "unavailable",
      },
    ]);
  });

  it("announces a permission flip on the status cadence", async () => {
    vi.useFakeTimers();
    let permissions: ComputerUsePermissions = granted;
    const provider = createMacosAppProvider({
      permissions: async () => permissions,
    });
    const events: IntegrationsModuleEvent[] = [];
    const handler = new ComputerAppModuleHandler({
      logger: { error: vi.fn(), info: vi.fn() },
      providers: [provider],
    });
    handlers.push(handler);
    handler.attach({
      browserAttachPublicKeys: undefined,
      fence,
      send: vi.fn(async (payload: Buffer | string) => {
        events.push(IntegrationsModuleEventSchema.parse(JSON.parse(payload.toString())));
      }),
    } satisfies RunnerModuleStream);

    await eventually(() => expect(events).toHaveLength(1));
    permissions = { accessibility: "denied", screenRecording: "granted" };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({
      apps: [
        {
          definitionId: "macos-app",
          operations: [
            expect.objectContaining({ operation: "observe", remedy: "accessibility" }),
            expect.objectContaining({ operation: "act", remedy: "accessibility" }),
          ],
        },
      ],
    });
  });
});

const fence = {
  auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(
    "rax_00000000-0000-4000-8000-000000000001",
  ),
  bootId: RunnerBootIdSchema.parse("rbt_00000000-0000-4000-8000-000000000002"),
  connectionGeneration: 1,
  connectionId: RunnerConnectionIdSchema.parse("rcn_00000000-0000-4000-8000-000000000003"),
  connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(
    "rls_00000000-0000-4000-8000-000000000004",
  ),
  module: "integrations" as const,
  runnerId: createId("runner"),
};

const screenRecordingRequired = {
  detail: computerUseScreenRecordingSentence,
  remedy: "screen-recording",
  state: "permission-required",
} as const;

const accessibilityRequired = {
  detail: computerUseAccessibilitySentence,
  remedy: "accessibility",
  state: "permission-required",
} as const;

async function inspectWith(
  permissions: ComputerUsePermissions,
): Promise<readonly ComputerAppOperationInspection[]> {
  const provider = createMacosAppProvider({ permissions: async () => permissions });
  return await provider.inspect();
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await Promise.resolve();
    }
  }
}
