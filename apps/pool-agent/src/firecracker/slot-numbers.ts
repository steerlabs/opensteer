/**
 * Slot numbers: each slot's index decides its uid, gid, namespace, veth, TAP and proxy user, so
 * two slots must never hold one. Every allocation, release and write of the number file, and
 * every host user the driver creates, happen under one host-wide lock (review G1).
 */
import { join } from "node:path";
import {
  readPrivateFileText,
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import { DriverStateUncertain } from "../driver.js";
import { Lane } from "../lane.js";

export const maximumSlots = 16_384;

export class SlotNumbers {
  readonly #file: string;
  readonly #lock = new Lane();
  readonly #write: (file: string, text: string) => Promise<void>;
  #numbers: Readonly<Record<string, number>> = {};
  /** A write failed: what is on disk is unknown, so nothing more is allocated or released. */
  #broken: DriverStateUncertain | undefined;

  constructor(
    directory: string,
    options: { readonly write?: (file: string, text: string) => Promise<void> } = {},
  ) {
    this.#file = join(directory, "slots.json");
    this.#write = options.write ?? replacePrivateFileAtomically;
  }

  async load(): Promise<void> {
    await securePrivateDirectory(join(this.#file, ".."));
    const text = await readPrivateFileText(this.#file, 1 << 20, {
      invalid: () => new Error("The driver's slot numbers are unreadable."),
      exposed: () => new Error("The driver's slot numbers are readable by other users."),
    });
    this.#numbers = text ? (JSON.parse(text) as Record<string, number>) : {};
  }

  get(slotId: string): number | undefined {
    return this.#numbers[slotId];
  }

  entries(): readonly [string, number][] {
    return Object.entries(this.#numbers);
  }

  /** Anything that must not run beside an allocation or a release (creating host users). */
  locked<T>(work: () => Promise<T>): Promise<T> {
    return this.#lock.run(work);
  }

  /**
   * The slot's number, allocated if it has none: the lowest free one, written before it is
   * returned. `prepare` runs under the lock with the new number; if it fails the number is
   * released again, so a failed create leaves nothing reserved.
   */
  allocate(slotId: string, prepare?: (index: number) => Promise<void>): Promise<number> {
    return this.#lock.run(async () => {
      if (this.#broken) throw this.#broken;
      const existing = this.#numbers[slotId];
      if (existing !== undefined) {
        await prepare?.(existing);
        return existing;
      }
      const used = new Set(Object.values(this.#numbers));
      let index = 0;
      while (used.has(index)) index += 1;
      if (index >= maximumSlots) throw new Error("This host has no free slot number.");
      await this.#save({ ...this.#numbers, [slotId]: index });
      try {
        await prepare?.(index);
      } catch (error) {
        const next = { ...this.#numbers };
        delete next[slotId];
        await this.#save(next);
        throw error;
      }
      return index;
    });
  }

  /** Frees the slot's number only after `cleanup` removed everything that used it. */
  release(slotId: string, cleanup: (index: number) => Promise<void>): Promise<void> {
    return this.#lock.run(async () => {
      if (this.#broken) throw this.#broken;
      const index = this.#numbers[slotId];
      if (index === undefined) return;
      await cleanup(index);
      const next = { ...this.#numbers };
      delete next[slotId];
      await this.#save(next);
    });
  }

  /** Re-check finding 5: rule S2 holds here too; a failed write is never retried in place. */
  async #save(next: Record<string, number>): Promise<void> {
    try {
      await this.#write(this.#file, JSON.stringify(next));
    } catch (error) {
      this.#broken = new DriverStateUncertain("The slot-number file write failed.", {
        cause: error,
      });
      throw this.#broken;
    }
    this.#numbers = next;
  }
}
