import type { WebContents } from "electron";
import { z } from "zod";
import {
  BrowserPresentedFrameSchema,
  BrowserVideoU64Schema,
  type BrowserVideoBudget,
  type BrowserPresentationRef,
} from "@opensteer/protocol";
import type {
  BrowserPresentationPort,
  BrowserProducerFrame,
} from "@opensteer/browser-runtime-core";

/** Private main-process capability. Never expose this handle or a generic proxy over IPC. */
export interface OpensteerInputOwner {
  sendCommand(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  detach(): void;
}
const enabledSchema = z.object({
  documentGeneration: z.string().min(1).max(512),
  authorityEpoch: z.string().min(1).max(512),
});
const startSchema = z.object({
  streamId: z.uuid(),
  backend: z.enum(["hardware", "software"]),
  capacity: z.number().int().min(1).max(8),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maxFps: z.number().int().min(1).max(60),
});
const chunkSchema = z.object({
  streamId: z.uuid(),
  generation: BrowserVideoU64Schema,
  sequence: BrowserVideoU64Schema,
  ptsUs: BrowserVideoU64Schema,
  key: z.boolean(),
  codec: z.string().optional(),
  width: z.number(),
  height: z.number(),
});

export function electronBrowserPresentation(contents: WebContents): BrowserPresentationPort {
  return new ElectronBrowserPresentation(() => {
    // The npm Electron types deliberately do not advertise the private owner.
    const patched = contents as WebContents & {
      _createOpensteerInputOwner?: () => OpensteerInputOwner;
    };
    if (typeof patched._createOpensteerInputOwner !== "function")
      throw new Error(
        "This Electron build lacks Opensteer H.264 presentation. Use the patched Electron distribution.",
      );
    return patched._createOpensteerInputOwner();
  });
}

export class ElectronBrowserPresentation implements BrowserPresentationPort {
  readonly #create: () => OpensteerInputOwner;
  #owner: OpensteerInputOwner | null = null;
  #stream: string | null = null;
  #epoch = 0;
  #remove: (() => void) | null = null;
  #stop: Promise<void> | null = null;
  #desiredBudget: BrowserVideoBudget | null = null;
  #updating: Promise<void> | null = null;
  constructor(create: () => OpensteerInputOwner) {
    this.#create = create;
  }
  async start(options: Parameters<BrowserPresentationPort["start"]>[0]) {
    if (this.#stop) await this.#stop;
    if (this.#owner) throw new Error("Browser presentation owner is already active.");
    const owner = this.#create();
    const epoch = ++this.#epoch;
    this.#owner = owner;
    let authority: z.infer<typeof enabledSchema> | null = null;
    const stopped = () => {
      if (this.#owner !== owner || epoch !== this.#epoch) return;
      // Revoke JS publication before cleanup can run arbitrary native listeners.
      this.#stream = null;
      this.#desiredBudget = null;
      this.#updating = null;
      ++this.#epoch;
      this.#owner = null;
      this.#remove?.();
      this.#remove = null;
      queueMicrotask(() => {
        owner.detach();
        options.onStopped("source-ended");
      });
    };
    const chunk = (...args: unknown[]) => {
      if (this.#owner !== owner || epoch !== this.#epoch) return;
      try {
        const bytes = args[1];
        const raw = args[2];
        if (!Buffer.isBuffer(bytes) || !authority || !raw || typeof raw !== "object")
          throw new Error("Invalid native browser video resource.");
        const metadata = chunkSchema.parse(raw);
        if ("documentGeneration" in raw && raw.documentGeneration !== authority.documentGeneration)
          throw new Error("Native browser document changed.");
        if (this.#stream !== null && metadata.streamId !== this.#stream)
          throw new Error("Native browser stream changed without replacement.");
        this.#stream = metadata.streamId;
        const presentation = BrowserPresentedFrameSchema.strip().parse({
          ...raw,
          producerStreamId: metadata.streamId,
          documentGeneration: authority.documentGeneration,
          authorityEpoch: authority.authorityEpoch,
        });
        // Native metadata includes diagnostics; none becomes input authority or an expiry policy.
        const frame: BrowserProducerFrame = {
          generation: metadata.generation,
          sequence: metadata.sequence,
          ptsUs: metadata.ptsUs,
          key: metadata.key,
          ...(metadata.codec ? { codec: metadata.codec } : {}),
          width: metadata.width,
          height: metadata.height,
          presentation,
          payload: bytes,
        };
        options.onFrame(frame);
      } catch {
        stopped();
      }
    };
    owner.on("video-chunk", chunk);
    owner.on("video-stopped", stopped);
    owner.on("detach", stopped);
    this.#remove = () => {
      owner.off("video-chunk", chunk);
      owner.off("video-stopped", stopped);
      owner.off("detach", stopped);
    };
    try {
      authority = enabledSchema.parse(await owner.sendCommand("OpensteerInput.enable"));
      if (this.#owner !== owner || epoch !== this.#epoch)
        throw new Error("Browser owner ended during enable.");
      const { maxBitrate, ...budget } = options.budget;
      const result = startSchema.parse(
        await owner.sendCommand("OpensteerVideo.start", {
          ...budget,
          bitrate: maxBitrate,
          creditWindow: options.creditWindow,
          backend: "auto",
        }),
      );
      if (
        this.#owner !== owner ||
        epoch !== this.#epoch ||
        (this.#stream !== null && this.#stream !== result.streamId)
      )
        throw new Error("Browser owner ended during start.");
      this.#stream = result.streamId;
      return {
        producerStreamId: result.streamId,
        capacity: { backend: result.backend, maxSessions: result.capacity, maxFps: result.maxFps },
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  budget(budget: BrowserVideoBudget): Promise<void> {
    this.#desiredBudget = budget;
    if (this.#updating) return this.#updating;
    const epoch = this.#epoch;
    const updating = (async () => {
      while (this.#desiredBudget && this.#epoch === epoch) {
        const { maxBitrate, ...next } = this.#desiredBudget;
        this.#desiredBudget = null;
        await this.#command("OpensteerVideo.update", { ...next, bitrate: maxBitrate });
      }
    })().finally(() => {
      if (this.#updating === updating) this.#updating = null;
    });
    this.#updating = updating;
    return updating;
  }
  async keyframe(): Promise<void> {
    await this.#command("OpensteerVideo.requestKeyframe");
  }
  async ack(sequence: string, retainFor: readonly string[]): Promise<void> {
    await this.#command("OpensteerVideo.ack", { sequence, retainFor });
  }
  async hold(slot: string, reference: BrowserPresentationRef): Promise<void> {
    await this.#command("OpensteerVideo.retain", { slot, drawnRevision: reference.drawnRevision });
  }
  async presented(slot: string, reference: BrowserPresentationRef): Promise<void> {
    await this.#command("OpensteerVideo.presented", {
      slot,
      drawnRevision: reference.drawnRevision,
    });
  }
  async recover(slot: string, through: number): Promise<void> {
    await this.#command("OpensteerVideo.release", { slot, offeredThrough: String(through) });
  }
  async release(slot: string): Promise<void> {
    await this.#command("OpensteerVideo.release", { slot });
  }
  async click(
    input: Parameters<BrowserPresentationPort["click"]>[0],
  ): Promise<{ dispatched: boolean }> {
    const owner = this.#owner;
    if (!owner || !this.#stream) throw new Error("Browser owner ended.");
    const { reference, seq, rootCssPoint, modifiers } = input;
    return z.object({ dispatched: z.boolean() }).parse(
      await owner.sendCommand("OpensteerInput.click", {
        documentGeneration: reference.documentGeneration,
        authorityEpoch: reference.authorityEpoch,
        drawnRevision: reference.drawnRevision,
        seq,
        after: "0",
        rootCssPoint,
        button: "left",
        modifiers,
      }),
    );
  }
  stop(): Promise<void> {
    if (this.#stop) return this.#stop;
    const owner = this.#owner;
    this.#owner = null;
    this.#stream = null;
    ++this.#epoch;
    this.#desiredBudget = null;
    this.#updating = null;
    this.#remove?.();
    this.#remove = null;
    if (!owner) return Promise.resolve();
    this.#stop = (async () => {
      try {
        await owner.sendCommand("OpensteerVideo.stop");
      } finally {
        owner.detach();
      }
    })().finally(() => {
      this.#stop = null;
    });
    return this.#stop;
  }
  #command(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.#owner || !this.#stream)
      return Promise.reject(new Error("Browser presentation ended."));
    return this.#owner.sendCommand(method, { streamId: this.#stream, ...params });
  }
}
