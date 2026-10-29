import { describe, expect, it } from "vitest";
import {
  BrowserTabOpenCommandSchema,
  BrowserTabOpenResultSchema,
  projectBrowserSessionOpener,
} from "./browser.js";
import { ComputerViewRefSchema } from "./computer-view-requests.js";
import { HostIntegrationsComputerViewSchema } from "./computer-apps.js";
import {
  ComputerViewOpenCommandSchema,
  ComputerViewSchema,
  computerOwnerViewVersion,
} from "./computer-view.js";
import { MachineComputerUseSchema, ComputerUseHelloResultSchema } from "./computer-use.js";
import { RunnerIdSchema, UserIdSchema, ThreadIdSchema, RunIdSchema } from "@opensteer/core";
const machineId = RunnerIdSchema.parse("rnr_11111111-1111-4111-8111-111111111111");
const userId = UserIdSchema.parse("usr_11111111-1111-4111-8111-111111111111");
const threadId = ThreadIdSchema.parse("thr_11111111-1111-4111-8111-111111111111");
const base = { type: "browser.tab.open", idempotencyKey: "retry" };
describe("start-page wire contracts", () => {
  it("accepts exactly one target and only safe web addresses", () => {
    const session = { sessionId: "bsn_11111111-1111-4111-8111-111111111111" };
    const identity = { identity: { kind: "guest" } };
    for (const target of [
      session,
      identity,
      { ...identity, placement: { kind: "runner", runnerId: machineId } },
    ])
      expect(BrowserTabOpenCommandSchema.safeParse({ ...base, ...target }).success).toBe(true);
    for (const target of [
      {},
      { ...session, ...identity },
      { ...session, placement: { kind: "runner", runnerId: machineId } },
      { ...identity, workspaceId: "wsp_forged" },
      { ...identity, url: "javascript:alert(1)" },
      { ...identity, url: "https://user:secret@example.com" },
    ])
      expect(BrowserTabOpenCommandSchema.safeParse({ ...base, ...target }).success).toBe(false);
    expect(BrowserTabOpenResultSchema.safeParse({ type: base.type }).success).toBe(false);
    expect(
      BrowserTabOpenCommandSchema.safeParse({
        ...base,
        identity: { kind: "guest", profileId: "forged" },
      }).success,
    ).toBe(false);
    expect(
      BrowserTabOpenCommandSchema.safeParse({
        ...base,
        identity: { kind: "guest" },
        viewport: { width: 1200, height: 800 },
      }).success,
    ).toBe(true);
  });
  it("projects opener relative to the reader without leaking another user or hidden thread", () => {
    const reader = { userId, visibleThreadIds: new Set<string>() };
    expect(projectBrowserSessionOpener({ kind: "person", userId }, reader)).toEqual({
      kind: "you",
    });
    expect(
      projectBrowserSessionOpener(
        { kind: "person", userId: UserIdSchema.parse("usr_22222222-2222-4222-8222-222222222222") },
        reader,
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      projectBrowserSessionOpener(
        {
          kind: "task",
          threadId,
          runId: RunIdSchema.parse("run_11111111-1111-4111-8111-111111111111"),
        },
        reader,
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      projectBrowserSessionOpener(
        {
          kind: "task",
          threadId,
          runId: RunIdSchema.parse("run_11111111-1111-4111-8111-111111111111"),
        },
        { ...reader, visibleThreadIds: new Set([threadId]) },
      ),
    ).toEqual({ kind: "task", threadId });
    expect(projectBrowserSessionOpener(null, reader)).toEqual({ kind: "unknown" });
  });
  it("requires an exact native target and generation; old producers do not claim support", () => {
    expect(computerOwnerViewVersion).toBe(1);
    expect(
      HostIntegrationsComputerViewSchema.safeParse({
        type: "host.integrations.computer-view",
        operation: "capture",
        viewId: "cvw_11111111-1111-4111-8111-111111111111",
        generation: 1,
      }).success,
    ).toBe(false);
    expect(
      ComputerViewOpenCommandSchema.safeParse({
        type: "computer.view.open",
        machineId,
        target: { kind: "phone", display: "main" },
        idempotencyKey: "open",
      }).success,
    ).toBe(true);
    expect(
      ComputerViewOpenCommandSchema.safeParse({
        type: "computer.view.open",
        machineId,
        target: { kind: "phone", display: "main", runId: "fake" },
        idempotencyKey: "open",
      }).success,
    ).toBe(false);
    expect(
      ComputerViewRefSchema.safeParse({
        viewId: "cvw_11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
    expect(ComputerViewSchema.safeParse({}).success).toBe(false);
    expect(
      ComputerUseHelloResultSchema.parse({
        helperVersion: "1",
        minProtocolVersion: 8,
        protocolVersion: 8,
        permissions: { accessibility: "granted", screenRecording: "granted" },
      }).ownerViewVersion,
    ).toBeUndefined();
    expect(MachineComputerUseSchema.shape.ownerViewVersion.isOptional()).toBe(true);
  });
});
