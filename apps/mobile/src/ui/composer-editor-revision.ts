/*
 * Ported from T3 Code's apps/mobile/src/native/composerEditorRevision.ts
 * (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
 */
import type { ComposerSelection } from "@opensteer/client/references";
import type { NativeComposerState } from "../../modules/composer-editor/index.js";

export type { NativeComposerState };

interface Snapshot {
  readonly eventCount: number;
  readonly value: string;
  /** Null for a state the parent assumed native holds, whose caret native chose. */
  readonly selection: ComposerSelection | null;
}

/** The revision stamp a render sends native with its value and caret. */
export interface ControlledStamp {
  readonly eventCount: number;
  readonly generation: number;
  /** The value and caret are what native last reported; native keeps its own. */
  readonly isNativeEcho: boolean;
}

/**
 * Orders a controlled native editor's events against React's renders.
 *
 * Native stamps every event with an increasing count and the reset generation it
 * has applied. A render that lags the newest acknowledged event is stamped behind
 * it, so native rejects it instead of moving the caret or restoring stale text
 * mid-typing. A reset (a send clearing the field, a restored draft) raises the
 * generation: native applies it over edits the parent never saw, and events from
 * before it are dropped here.
 */
export class ComposerRevision {
  #eventCount = 0;
  #generation = 0;
  #nativeGeneration = 0;
  // Empty at first, so a restored draft or recycled view receives a non-echo payload.
  #snapshots: Snapshot[] = [];

  /** The newest native event this editor has accepted. */
  get eventCount(): number {
    return this.#eventCount;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Accepts a native event unless it is older than one already accepted or than a reset. */
  accept(state: NativeComposerState): boolean {
    if (
      !Number.isSafeInteger(state.eventCount) ||
      state.eventCount <= this.#eventCount ||
      state.generation < this.#generation
    )
      return false;
    this.#eventCount = state.eventCount;
    this.#nativeGeneration = state.generation;
    this.#snapshots.push({
      eventCount: state.eventCount,
      value: state.value,
      selection: state.selection,
    });
    return true;
  }

  /** The parent replaces the text outright; native edits made before it are dropped. */
  reset(): number {
    this.#generation += 1;
    return this.#generation;
  }

  /** Native applied a reset this editor has not raised (a fresh view adopting older state). */
  adopt(generation: number): void {
    if (generation > this.#generation) this.#generation = generation;
  }

  stamp(value: string, selection: ComposerSelection | null): ControlledStamp {
    // Native restarts its count at a reset's stamp, so the reset carries the latest one.
    if (this.#generation > this.#nativeGeneration)
      return { eventCount: this.#eventCount, generation: this.#generation, isNativeEcho: false };
    const eventCount = this.#controlledEventCount(value, selection);
    return {
      eventCount,
      generation: this.#generation,
      isNativeEcho: eventCount === this.#eventCount && this.#isEcho(value, selection),
    };
  }

  /** After a render's payload is committed: forget what it acknowledged, or record what it set. */
  settle(stamp: ControlledStamp, value: string, selection: ComposerSelection | null): void {
    if (stamp.generation > this.#nativeGeneration) {
      this.#snapshots = [{ eventCount: stamp.eventCount, value, selection: null }];
      return;
    }
    if (this.#isEcho(value, selection)) {
      this.#prune();
      return;
    }
    // Newer native events make this payload stale; it is not native's state.
    if (stamp.isNativeEcho || stamp.eventCount !== this.#eventCount) return;
    // Returning to an old native value later must count as a fresh parent edit.
    this.#snapshots = [
      { eventCount: stamp.eventCount, value, selection: null },
      ...this.#snapshots.filter((snapshot) => snapshot.eventCount > stamp.eventCount),
    ];
  }

  #controlledEventCount(value: string, selection: ComposerSelection | null): number {
    let newestValueEventCount: number | null = null;
    for (let index = this.#snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.#snapshots[index]!;
      if (snapshot.value !== value) continue;
      newestValueEventCount ??= snapshot.eventCount;
      if (
        selection === null ||
        snapshot.selection === null ||
        sameSelection(snapshot.selection, selection)
      )
        return snapshot.eventCount;
    }
    // A native text paired with a stale caret is an intermediate render: keep it behind.
    if (newestValueEventCount !== null && this.#eventCount > 0)
      return Math.min(newestValueEventCount, this.#eventCount - 1);
    return this.#eventCount;
  }

  #isEcho(value: string, selection: ComposerSelection | null): boolean {
    for (let index = this.#snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.#snapshots[index]!;
      if (
        snapshot.eventCount === this.#eventCount &&
        snapshot.value === value &&
        (selection === null ||
          (snapshot.selection !== null && sameSelection(snapshot.selection, selection)))
      )
        return true;
    }
    return false;
  }

  // Keeps the newest acknowledged snapshot so settled re-renders stay echoes.
  #prune(): void {
    let latest = -1;
    for (let index = this.#snapshots.length - 1; index >= 0; index -= 1) {
      if (this.#snapshots[index]!.eventCount <= this.#eventCount) {
        latest = index;
        break;
      }
    }
    this.#snapshots = this.#snapshots.filter(
      (snapshot, index) => index === latest || snapshot.eventCount > this.#eventCount,
    );
  }
}

function sameSelection(left: ComposerSelection, right: ComposerSelection): boolean {
  return left.start === right.start && left.end === right.end;
}
