import type { WebContents } from "electron";
import { z } from "zod";
import {
  BrowserPresentedFrameSchema,
  BrowserClickRefusalReasonSchema,
  projectNativePopupState,
  type BrowserPopupAnswer,
  type BrowserPrivateEdit,
  type BrowserClickRefusalReason,
  BrowserVideoU64Schema,
  type BrowserVideoBudget,
} from "@opensteer/protocol";
import type {
  BrowserPresentationPort,
  BrowserProducerFrame,
  NativeBrowserPopupRef,
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
  capacity: z.number().int().min(1).max(8).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maxFps: z.number().int().min(1).max(60).optional(),
});
const chunkSchema = z.object({
  streamId: z.uuid(),
  sequence: BrowserVideoU64Schema,
  timestampUs: BrowserVideoU64Schema,
  keyframe: z.boolean(),
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
  readonly popupVersion = 1 as const;
  #authority: z.infer<typeof enabledSchema> | null = null;
  #focusToken = "";
  #popup: NativeBrowserPopupRef | null = null;
  readonly #popupRefs = new Map<string, NativeBrowserPopupRef>();
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
      this.#authority = null;
      this.#focusToken = "";
      this.#popup = null;
      this.#popupRefs.clear();
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
        if (this.#stream !== null && metadata.streamId !== this.#stream)
          throw new Error("Native browser stream changed without replacement.");
        this.#stream = metadata.streamId;
        const presentation = BrowserPresentedFrameSchema.strip().parse({
          ...("certificate" in raw && typeof raw.certificate === "object" ? raw.certificate : {}),
          rasterCrop: "rasterCrop" in raw ? raw.rasterCrop : undefined,
          producerStreamId: metadata.streamId,
        });
        if (
          presentation.documentGeneration !== authority.documentGeneration ||
          presentation.authorityEpoch !== authority.authorityEpoch
        )
          throw new Error("Native browser authority changed.");
        // Native metadata includes diagnostics; none becomes input authority or an expiry policy.
        const frame: BrowserProducerFrame = {
          generation: "1",
          sequence: metadata.sequence,
          ptsUs: metadata.timestampUs,
          key: metadata.keyframe,
          ...(metadata.keyframe ? { codec: browserCodec(bytes) } : {}),
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
    const message = (...args: unknown[]) => {
      if (this.#owner !== owner || epoch !== this.#epoch || !authority) return;
      const method = args[1];
      if (
        typeof method !== "string" ||
        !["OpensteerPopup.opened", "OpensteerPopup.updated", "OpensteerPopup.closed"].includes(
          method,
        )
      )
        return;
      try {
        const raw = z.record(z.string(), z.unknown()).parse(args[2]);
        if (method === "OpensteerPopup.closed") {
          const id = z.string().min(1).max(512).parse(raw.popupId);
          const ref = this.#popupRefs.get(id);
          if (!ref) {
            options.onPopup?.({
              type: "unavailable",
              reason:
                raw.reason === "limit"
                  ? "limit"
                  : raw.reason === "unsupported"
                    ? "unsupported"
                    : "unavailable",
            });
            return;
          }
          if (this.#popup?.popupId === id) this.#popup = null;
          this.#focusToken = "";
          const reason = z.enum(["canceled", "expired"]).safeParse(raw.reason);
          options.onPopup?.({
            type: "closed",
            ref,
            reason:
              raw.reason === "accepted" ? "applied" : reason.success ? reason.data : "interrupted",
          });
          return;
        }
        const popupId = z.string().min(1).max(512).parse(raw.popupId);
        const revision = BrowserVideoU64Schema.refine((v) => v !== "0").parse(raw.revision);
        if (method === "OpensteerPopup.opened") {
          // This private native API admits only the primary frame without children.
          z.string().min(1).max(512).parse(raw.frameId);
          if (
            raw.documentGeneration !== authority.documentGeneration ||
            raw.authorityEpoch !== authority.authorityEpoch
          )
            return;
          this.#popup = { ...authority, popupId, revision };
          this.#popupRefs.set(popupId, this.#popup);
          if (this.#popupRefs.size > 32)
            this.#popupRefs.delete(this.#popupRefs.keys().next().value!);
        } else {
          if (!this.#popup || this.#popup.popupId !== popupId) return;
          this.#popup = { ...this.#popup, revision };
          this.#popupRefs.set(popupId, this.#popup);
        }
        const state = projectNativePopupState(raw.state);
        options.onPopup?.({
          type: method === "OpensteerPopup.opened" ? "opened" : "updated",
          ref: this.#popup!,
          state,
        });
      } catch {
        // Never attach schema/native errors: they can contain private labels and values.
        const ref = this.#popup;
        this.#popup = null;
        if (ref) void this.cancelPopup(ref).catch(() => undefined);
        options.onPopup?.({ type: "unavailable", reason: "limit" });
      }
    };
    owner.on("message", message);
    owner.on("video-chunk", chunk);
    owner.on("video-stopped", stopped);
    owner.on("detach", stopped);
    this.#remove = () => {
      owner.off("message", message);
      owner.off("video-chunk", chunk);
      owner.off("video-stopped", stopped);
      owner.off("detach", stopped);
    };
    try {
      authority = enabledSchema.parse(await owner.sendCommand("OpensteerInput.enable"));
      this.#authority = authority;
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
        ...(result.capacity
          ? {
              capacity: {
                backend: result.backend,
                maxSessions: result.capacity,
                maxFps: result.maxFps ?? options.budget.maxFps,
              },
            }
          : {}),
      };
    } catch (error) {
      if (this.#owner === owner && this.#epoch === epoch) await this.stop();
      throw error;
    }
  }
  budget(budget: BrowserVideoBudget): Promise<void> {
    this.#desiredBudget = budget;
    if (this.#updating) return this.#updating;
    const epoch = this.#epoch;
    const updating = (async () => {
      while (this.#desiredBudget && this.#epoch === epoch) {
        const { maxBitrate, maxFps } = this.#desiredBudget;
        this.#desiredBudget = null;
        await this.#command("OpensteerVideo.update", { maxFps, bitrate: maxBitrate });
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
  async ack(sequence: string): Promise<void> {
    await this.#command("OpensteerVideo.ack", { sequence });
  }
  async click(
    input: Parameters<BrowserPresentationPort["click"]>[0],
  ): Promise<{ dispatched: boolean; reason?: BrowserClickRefusalReason }> {
    const owner = this.#owner;
    if (!owner || !this.#stream) throw new Error("Browser owner ended.");
    const { reference, seq, rootCssPoint, modifiers } = input;
    this.#focusToken = "";
    const result = z.object({ dispatched: z.boolean(), reason: z.string().optional() }).safeParse(
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
    if (!result.success) throw new Error("Invalid private input result.");
    const reason = BrowserClickRefusalReasonSchema.safeParse(result.data.reason);
    return {
      dispatched: result.data.dispatched,
      ...(!result.data.dispatched && reason.success ? { reason: reason.data } : {}),
    };
  }
  async answerPopup(
    ref: NativeBrowserPopupRef,
    answer: BrowserPopupAnswer,
  ): Promise<{ applied: boolean }> {
    const owner = this.#owner;
    if (!owner) throw new Error("Browser owner ended.");
    const { documentGeneration, authorityEpoch, popupId, revision } = ref;
    const result = z.object({ applied: z.boolean() }).safeParse(
      await owner.sendCommand("OpensteerPopup.answer", {
        documentGeneration,
        authorityEpoch,
        popupId,
        revision,
        answer,
      }),
    );
    if (!result.success) throw new Error("Invalid private popup result.");
    return result.data;
  }
  async cancelPopup(ref: NativeBrowserPopupRef): Promise<void> {
    const { documentGeneration, authorityEpoch, popupId, revision } = ref;
    await this.#owner?.sendCommand("OpensteerPopup.cancel", {
      documentGeneration,
      authorityEpoch,
      popupId,
      revision,
    });
  }
  async edit(
    input: BrowserPrivateEdit,
    nextSequence: () => string,
    current: () => boolean = () => true,
  ): Promise<{ dispatched: boolean }> {
    const owner = this.#owner;
    const authority = this.#authority;
    const epoch = this.#epoch;
    if (!owner || !authority) return { dispatched: false };
    const response = z.object({ dispatched: z.boolean(), focusToken: z.string().max(512) });
    const command = async (
      type: "capture" | "keyDown" | "keyUp" | "insertText",
      focusToken: string,
    ) => {
      const raw = await owner
        .sendCommand("OpensteerInput.edit", {
          ...authority,
          seq: nextSequence(),
          focusToken,
          type,
          key: "key" in input && type !== "capture" ? input.key : "",
          code: "code" in input && type !== "capture" ? input.code : "",
          keyCode: "keyCode" in input && type !== "capture" ? input.keyCode : 0,
          modifiers: "modifiers" in input && type !== "capture" ? input.modifiers : 0,
          text: type === "capture" || type === "keyUp" ? "" : input.text,
        })
        .catch(() => {
          throw new Error("Private editing outcome is uncertain.");
        });
      const result = response.safeParse(raw);
      if (!result.success) throw new Error("Invalid private editing result.");
      return result.data;
    };
    if (
      new TextEncoder().encode(input.text).byteLength > 4096 ||
      (input.type === "keyDown" && input.text.length >= 4)
    )
      return { dispatched: false };
    if (!this.#focusToken && input.type === "keyUp") return { dispatched: false };
    if (!this.#focusToken) {
      const captured = await command("capture", "");
      if (this.#owner !== owner || this.#epoch !== epoch || !captured.focusToken || !current())
        return { dispatched: false };
      this.#focusToken = captured.focusToken;
    }
    if (!current()) return { dispatched: false };
    const result = await command(input.type, this.#focusToken);
    if (this.#owner !== owner || this.#epoch !== epoch) return { dispatched: false };
    this.#focusToken = result.focusToken;
    return { dispatched: result.dispatched };
  }
  stop(): Promise<void> {
    if (this.#stop) return this.#stop;
    const owner = this.#owner;
    this.#owner = null;
    this.#authority = null;
    this.#focusToken = "";
    this.#popup = null;
    this.#popupRefs.clear();
    this.#stream = null;
    ++this.#epoch;
    this.#desiredBudget = null;
    this.#updating = null;
    this.#remove?.();
    this.#remove = null;
    if (!owner) return Promise.resolve();
    this.#stop = (async () => {
      try {
        try {
          await owner.sendCommand("OpensteerInput.disable");
        } finally {
          await owner.sendCommand("OpensteerVideo.stop");
        }
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

// Codec configuration is part of translating Annex B to the shared envelope;
// the Host validates the complete access unit before sending it to a viewer.
function browserCodec(bytes: Uint8Array): string {
  for (let i = 0; i + 7 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    const length = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
    if (length && (bytes[i + length]! & 31) === 7)
      return `avc1.${[...bytes.subarray(i + length + 1, i + length + 4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Browser keyframe has no codec configuration.");
}
