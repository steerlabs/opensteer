import {
  browserPoolControlBytes,
  type BrowserPoolControl,
  type BrowserPoolDocument,
  type BrowserPoolRuntimeFence,
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
import { isDeepStrictEqual } from "node:util";
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
  adopt?: (
    documents: readonly BrowserPoolDocument[],
    fence: BrowserPoolRuntimeFence,
    attachment: number,
  ) => Promise<readonly BrowserPoolDocument[]>;
}) {
  const { database, target, runtime, physical, controllerKey } = input;
  const state = () => {
    const state = runtime.poolState();
    if (!state || state.fence.instance !== target.instanceId || state.fence.term !== target.term)
      throw new BrowserPoolAdmissionClosed();
    return state;
  };
  const read = () => readBrowserPoolSlot(database, target.runnerId);
  const driveRuntime = (
    slot: BrowserPoolSlot,
    kind: BrowserPoolControl["kind"],
    documents?: readonly BrowserPoolDocument[],
    epoch = slot.epoch,
  ) => {
    const control = {
      kind,
      fence: { term: slot.term, instance: slot.instanceId, epoch },
      intent: { id: slot.intentId, sequence: slot.intentSequence },
      ...(documents ? { documents } : {}),
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
  const park = async (slot: BrowserPoolSlot) => {
    if (!input.adopt && runtime.health().sessionCount !== 0) return abortPark(slot);
    const retired = await driveRuntime(slot, "retire");
    if (retired.phase === "running") return abortPark(slot);
    if (
      (retired.phase !== "retired" && retired.phase !== "sealed") ||
      !retired.result ||
      retired.result.dropped.length
    )
      throw new BrowserPoolAdmissionClosed();
    const recorded = await advanceBrowserPoolSlot(database, slot, {
      phase: "preparing",
      epoch: slot.epoch,
      retained: { ...retired.result },
    });
    await driveRuntime(recorded, "seal");
    await drivePhysical(recorded, "pause");
    return advance(recorded, "parked");
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
    park,
    abortPark,
    wake: async (slot) => {
      const waking = slot.phase === "waking" ? slot : await advance(slot, "waking");
      await drivePhysical(waking, "resume");
      const documents = state().result?.retained;
      if (!documents || !isDeepStrictEqual(waking.retained?.retained, documents))
        throw new BrowserPoolAdmissionClosed();
      const adoption = await driveRuntime(waking, "adopt", documents);
      if (adoption.phase !== "adopting") throw new BrowserPoolAdmissionClosed();
      const attaching = await advanceBrowserPoolSlot(database, waking, {
        phase: "waking",
        epoch: waking.epoch,
        retained: waking.retained,
        attachmentGeneration: waking.attachmentGeneration + 1,
      });
      const admitted =
        (await input.adopt?.(documents, adoption.fence, attaching.attachmentGeneration)) ?? [];
      const completed = await driveRuntime(waking, "complete", admitted, adoption.fence.epoch);
      if (completed.phase !== "running" || !completed.adoption?.outcome)
        throw new BrowserPoolAdmissionClosed();
      return advanceBrowserPoolSlot(database, attaching, {
        phase: "running",
        epoch: completed.fence.epoch,
        retained: { ...waking.retained, ...completed.adoption.outcome },
      });
    },
  });
  let slot = await read();
  const observed = await status();
  const runtimeState = state();
  if (slot) {
    const resumingAdoption =
      slot.phase === "waking" &&
      runtimeState.intent?.id === slot.intentId &&
      runtimeState.fence.epoch === slot.epoch + 1 &&
      runtimeState.phase === "adopting";
    if (
      slot.runtimeId !== target.runtimeId ||
      slot.slotId !== target.slotId ||
      slot.term !== target.term ||
      slot.instanceId !== target.instanceId ||
      (slot.epoch !== runtimeState.fence.epoch && !resumingAdoption)
    )
      throw new BrowserPoolAdmissionClosed();
    if (slot.phase === "preparing") {
      if (runtimeState.phase === "running" || runtimeState.phase === "releasing") {
        // Even a not-yet-delivered retire needs a signed tombstone before opening.
        slot = await abortPark(slot);
      } else {
        if (runtimeState.intent?.id !== slot.intentId) throw new BrowserPoolAdmissionClosed();
        slot = await park(slot);
      }
    } else if (slot.phase === "parked") {
      if (
        observed.phase !== "paused" ||
        observed.lastOperation !== `${slot.intentId}:pause` ||
        runtimeState.phase !== "sealed" ||
        runtimeState.intent?.id !== slot.intentId
      )
        throw new BrowserPoolAdmissionClosed();
    } else if (slot.phase === "waking") {
      const paused =
        observed.phase === "paused" && observed.lastOperation === `${slot.intentId}:pause`;
      const resumed =
        observed.phase === "running" && observed.lastOperation === `${slot.intentId}:resume`;
      if (
        runtimeState.intent?.id !== slot.intentId ||
        (resumingAdoption ? !resumed : runtimeState.phase !== "sealed" || (!paused && !resumed))
      )
        throw new BrowserPoolAdmissionClosed();
    } else if (
      slot.phase !== "running" ||
      observed.phase !== "running" ||
      runtimeState.phase !== "running" ||
      runtimeState.intent?.id !== slot.intentId
    ) {
      throw new BrowserPoolAdmissionClosed();
    }
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
