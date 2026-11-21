import {
  browserPoolControlBytes,
  type BrowserPoolControl,
  type BrowserRuntime,
} from "@opensteer/browser-runtime-core";
import {
  advanceBrowserPoolSlot,
  beginBrowserPoolPark,
  BrowserPoolAdmissionClosed,
  readBrowserPoolSlot,
  type BrowserPoolSlot,
  type BrowserPoolTargetIdentity,
  type DatabaseSchema,
} from "@opensteer/database";
import type { Kysely } from "kysely";
import { sign, type KeyObject } from "node:crypto";
import { BrowserPoolGate } from "./browser-pool-gate.js";

export interface LoopbackPoolPhysicalState {
  readonly slotId: string;
  readonly instanceId: string;
  readonly term: number;
  readonly phase: "running" | "paused" | "stopped";
  readonly lastOperation: string | null;
}

export interface LoopbackPoolPhysicalCommand {
  readonly kind: "pause" | "resume" | "stop" | "start";
  readonly id: string;
  readonly expect: LoopbackPoolPhysicalState;
}

/** The fake implements this port without receiving bridge keys or browser data. */
export interface LoopbackPoolPhysicalController {
  status(): Promise<LoopbackPoolPhysicalState>;
  apply(command: LoopbackPoolPhysicalCommand): Promise<LoopbackPoolPhysicalState>;
}

export async function createLoopbackBrowserPool(input: {
  database: Kysely<DatabaseSchema>;
  target: BrowserPoolTargetIdentity;
  runtime: BrowserRuntime;
  physical: LoopbackPoolPhysicalController;
  controllerKey: KeyObject;
}) {
  const { database, target, runtime, physical, controllerKey } = input;
  const state = () => {
    const state = runtime.poolState();
    if (!state || state.fence.instance !== target.instanceId || state.fence.term !== target.term)
      throw new BrowserPoolAdmissionClosed();
    return state;
  };
  const read = () => readBrowserPoolSlot(database, target.runnerId);
  const driveRuntime = (slot: BrowserPoolSlot, kind: BrowserPoolControl["kind"]) => {
    const control = {
      kind,
      fence: { term: slot.term, instance: slot.instanceId, epoch: slot.epoch },
      intent: { id: slot.intentId, sequence: slot.intentSequence },
    };
    return runtime.controlPool(
      control,
      sign(null, browserPoolControlBytes(control), controllerKey),
    );
  };
  const advance = (slot: BrowserPoolSlot, phase: BrowserPoolSlot["phase"], epoch = slot.epoch) =>
    advanceBrowserPoolSlot(database, slot, { phase, epoch, retained: slot.retained });
  const status = async () => {
    const observed = await physical.status();
    if (
      observed.slotId !== target.slotId ||
      observed.instanceId !== target.instanceId ||
      observed.term !== target.term
    )
      throw new BrowserPoolAdmissionClosed();
    return observed;
  };
  const drivePhysical = async (slot: BrowserPoolSlot, kind: "pause" | "resume") => {
    const id = `${slot.intentId}:${kind}`;
    const previous = await status();
    const phase = kind === "pause" ? "paused" : "running";
    if (previous.lastOperation === id && previous.phase === phase) return;
    if (
      kind === "pause"
        ? previous.phase !== "running"
        : previous.phase !== "paused" || previous.lastOperation !== `${slot.intentId}:pause`
    )
      throw new BrowserPoolAdmissionClosed();
    const command = { id, kind, expect: previous };
    try {
      await physical.apply(command);
    } catch {
      // A missed response and a missed request have different observations.
      const observed = await status();
      if (observed.phase === previous.phase && observed.lastOperation === previous.lastOperation)
        await physical.apply(command);
    }
    const current = await status();
    if (current.lastOperation !== id || current.phase !== phase)
      throw new BrowserPoolAdmissionClosed();
  };
  const abortPark = async (slot: BrowserPoolSlot) => {
    if ((await status()).phase !== "running") throw new BrowserPoolAdmissionClosed();
    const released = await driveRuntime(slot, "release");
    if (!released.cancelled || released.phase !== "running") throw new BrowserPoolAdmissionClosed();
    return advance(slot, "running", released.fence.epoch);
  };
  const gate = new BrowserPoolGate({
    read,
    begin: (id, demanded) =>
      beginBrowserPoolPark(
        database,
        {
          ...target,
          epoch: state().fence.epoch,
        },
        id,
        demanded,
      ),
    park: async (slot) => {
      // Retaining a Home session requires rebuilding its broker. Keep this
      // first entry point to an empty runtime until that restore path exists.
      if (runtime.health().sessionCount !== 0) return abortPark(slot);
      const retired = await driveRuntime(slot, "retire");
      if (retired.phase === "running") return abortPark(slot);
      if (
        retired.phase !== "retired" ||
        !retired.result ||
        retired.result.retained.length ||
        retired.result.dropped.length
      )
        throw new BrowserPoolAdmissionClosed();
      const recorded = await advanceBrowserPoolSlot(database, slot, {
        phase: "preparing",
        epoch: slot.epoch,
        retained: { ...retired.result },
      });
      await drivePhysical(recorded, "pause");
      return advance(recorded, "parked");
    },
    abortPark,
    wake: async (slot) => {
      const waking = await advance(slot, "waking");
      await drivePhysical(waking, "resume");
      return abortPark(waking);
    },
  });
  const slot = await read();
  const observed = await status();
  const runtimeState = state();
  if (slot) {
    if (
      slot.runtimeId !== target.runtimeId ||
      slot.slotId !== target.slotId ||
      slot.term !== target.term ||
      slot.instanceId !== target.instanceId ||
      slot.epoch !== runtimeState.fence.epoch ||
      (slot.phase === "parked"
        ? observed.phase !== "paused" ||
          observed.lastOperation !== `${slot.intentId}:pause` ||
          runtimeState.phase !== "retired" ||
          runtimeState.intent?.id !== slot.intentId
        : slot.phase !== "running" ||
          observed.phase !== "running" ||
          runtimeState.phase !== "running" ||
          runtimeState.intent?.id !== slot.intentId)
    )
      throw new BrowserPoolAdmissionClosed();
  } else if (
    observed.phase !== "running" ||
    observed.lastOperation ||
    runtimeState.phase !== "running" ||
    runtimeState.intent
  )
    throw new BrowserPoolAdmissionClosed();
  gate.recovered(slot);
  return { gate, fence: () => state().fence };
}
