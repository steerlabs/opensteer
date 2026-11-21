/**
 * The agent's durable journal: one record per slot, replaced atomically (written, synced,
 * renamed, directory synced) before every physical action and after it. A record that says an
 * action began and holds no result for it is what recovery settles, live or at start.
 */
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  readPrivateFileText,
  replacePrivateFileAtomically,
  securePrivateDirectory,
  discardPrivateFileTemporaryFiles,
} from "@opensteer/shared/atomicPrivateFile";
import type { BrowserPoolRuntimeFence } from "@opensteer/browser-runtime-core/browser-pool";
import type {
  BrowserPoolAgentCall,
  BrowserPoolAgentGuestSpec,
  BrowserPoolAgentPhase,
  BrowserPoolAgentResult,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import type { SavedImage } from "./driver.js";

export interface SavedStateRecord {
  readonly id: string;
  readonly discardAt: string;
  readonly parkedAt: string;
  /** Paused in memory, or written to the saved-state array with its VMM ended. */
  readonly tier: "memory" | "disk";
  /** The disk generation the live state was taken on; a restore requires the same one. */
  readonly diskGeneration: number;
  readonly image: SavedImage | null;
}

export type PendingRecord =
  | {
      readonly kind: "call";
      readonly call: BrowserPoolAgentCall;
      readonly step: string;
      readonly at: string;
      /** `start`: the new jail; `resume` from disk: the restoring jail. */
      readonly jailId?: string;
    }
  | {
      readonly kind: "save" | "discard";
      readonly savedStateId: string;
      readonly step: string;
      readonly at: string;
    };

export interface SlotRecord {
  readonly v: 1;
  readonly slotId: string;
  readonly term: number;
  /** SPKI DER, base64. */
  readonly homeKey: string;
  /** PKCS#8 DER, base64. The file is mode 0600 in a 0700 directory owned by the agent. */
  readonly controlKey: string;
  readonly guest: BrowserPoolAgentGuestSpec;
  readonly createdAt: string;
  readonly instance: string | null;
  readonly epoch: number | null;
  readonly phase: BrowserPoolAgentPhase;
  readonly saved: SavedStateRecord | null;
  /** The last control sequence issued; the next control is above it, also across restarts. */
  readonly sequence: number;
  /** The fence the agent last installed in this slot's runtime. */
  readonly installed: BrowserPoolRuntimeFence | null;
  /** Grows with every cold start on the profile disk: a newer writer existed. */
  readonly diskGeneration: number;
  /** The VMM process that owns the guest now, if any. */
  readonly jailId: string | null;
  /** Grows with every VMM process of this slot; part of every jail id. */
  readonly jailGeneration: number;
  /** The host incarnation the slot's VMM and saved state belong to. */
  readonly incarnation: string | null;
  readonly pending: PendingRecord | null;
  /** Stored results by call id, oldest first, with the time each was stored. */
  readonly results: readonly { readonly at: number; readonly result: BrowserPoolAgentResult }[];
  /** What changed physically, in order (bounded): diagnostics and tests. */
  readonly effects: readonly string[];
  /**
   * A deleted slot keeps a tombstone (its keys, no guest, no saved state) so its Home is told,
   * signed, that the slot is gone; it is never served again and is forgotten after a while.
   */
  readonly deletedAt?: string | null;
}

const maximumRecordBytes = 4 * 1024 * 1024;

const invalid = () => new Error("A pool agent journal record is unreadable.");
const exposed = () => new Error("A pool agent journal record is readable by other users.");

export class SlotJournal {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  get directory(): string {
    return this.#directory;
  }

  async open(): Promise<void> {
    await securePrivateDirectory(this.#directory);
    await discardPrivateFileTemporaryFiles(this.#directory, (name) => name.endsWith(".json"));
  }

  async list(): Promise<SlotRecord[]> {
    const names = (await readdir(this.#directory)).filter((name) =>
      /^slot-[a-f0-9]{64}\.json$/u.test(name),
    );
    const records: SlotRecord[] = [];
    for (const name of names.sort()) {
      const text = await readPrivateFileText(join(this.#directory, name), maximumRecordBytes, {
        invalid,
        exposed,
      });
      if (text === undefined) continue;
      const record = JSON.parse(text) as SlotRecord;
      if (record.v !== 1 || fileName(record.slotId) !== name) throw invalid();
      records.push(record);
    }
    return records;
  }

  async write(record: SlotRecord): Promise<void> {
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > maximumRecordBytes)
      throw new Error("A slot record is too large.");
    await replacePrivateFileAtomically(join(this.#directory, fileName(record.slotId)), text);
  }

  async remove(slotId: string): Promise<void> {
    await rm(join(this.#directory, fileName(slotId)), { force: true });
  }
}

function fileName(slotId: string): string {
  return `slot-${createHash("sha256").update(slotId).digest("hex")}.json`;
}
