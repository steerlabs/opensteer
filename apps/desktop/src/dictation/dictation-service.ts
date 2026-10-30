import {
  DictationAvailabilitySchema,
  DictationEventSchema,
  DictationSessionInputSchema,
  type DictationAvailability,
  type DictationEvent,
  type DictationError,
} from "@opensteer/protocol/dictation";
import type { DictationHelperClient } from "./helper-client.js";
import type { WebContents } from "electron";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";

type EndedEvent = Extract<DictationEvent, { type: "ended" }>;

type Active = { session: string; owner: WebContents; seq: number; cleanup: () => void };
export class DictationService {
  #active: Active | null = null;
  #closed = false;
  #used = new Set<string>();
  private readonly options: {
    client: DictationHelperClient;
    platform: string;
    arch: string;
    osMajor: number;
    translated?: boolean;
    openSettings: () => Promise<void>;
  };
  constructor(options: DictationService["options"]) {
    this.options = options;
    options.client.subscribe(
      (event) => this.#receive(event),
      () => this.#terminate("service-unavailable"),
    );
  }
  async availability(): Promise<DictationAvailability> {
    const unavailable = this.#ineligible();
    if (unavailable) return unavailable;
    return DictationAvailabilitySchema.parse(await this.options.client.call("availability"));
  }
  #ineligible(): DictationAvailability | null {
    if (this.options.platform !== "darwin") return { available: false, reason: "platform" };
    if (this.options.osMajor < 25) return { available: false, reason: "os" };
    if (this.options.arch !== "arm64" || this.options.translated)
      return { available: false, reason: "hardware" };
    return null;
  }
  async command(
    owner: WebContents,
    method: "start" | "download" | "stop" | "cancel",
    input: unknown,
  ): Promise<void> {
    const { session } = DictationSessionInputSchema.parse(input);
    if (this.#closed || owner.isDestroyed()) throw new Error("Dictation is closed");
    if (method === "stop" || method === "cancel") {
      if (this.#active?.owner !== owner || this.#active.session !== session) return;
    } else {
      if (this.#ineligible()) throw new Error("Dictation is unavailable on this system");
      if (this.#active?.session === session && this.#active.owner === owner) return;
      if (this.#used.has(session)) throw new Error("Dictation session has already ended");
      this.#used.add(session);
      if (this.#active) {
        this.#send(owner, { type: "ended", session, seq: 1, reason: "failed", error: "busy" });
        return;
      }
      const cancel = () => {
        if (this.#active?.owner !== owner) return;
        const active = this.#active;
        this.#terminate(null, false);
        void this.options.client.call("cancel", active.session).catch(() => undefined);
      };
      owner.once("destroyed", cancel);
      owner.once("render-process-gone", cancel);
      const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace) cancel();
      };
      owner.on("did-start-navigation", navigating);
      this.#active = {
        owner,
        session,
        seq: 0,
        cleanup: () => {
          owner.removeListener("destroyed", cancel);
          owner.removeListener("render-process-gone", cancel);
          owner.removeListener("did-start-navigation", navigating);
        },
      };
    }
    const active = this.#active;
    try {
      await this.options.client.call(method, session);
    } catch (error) {
      if (this.#active === active) this.#terminate("service-unavailable");
      throw error;
    }
  }
  async openMicrophoneSettings(): Promise<void> {
    await this.options.openSettings();
  }
  interrupt(): void {
    const active = this.#active;
    if (!active) return;
    void this.options.client.call("interrupt").catch(() => {
      if (this.#active === active) this.#terminate("service-unavailable");
    });
  }
  close(): void {
    this.#closed = true;
    this.#terminate(null, false);
    this.options.client.close();
  }
  #send(owner: WebContents, event: DictationEvent): void {
    if (!owner.isDestroyed())
      owner.send(desktopBridgeChannels.dictationEvent, DictationEventSchema.parse(event));
  }
  #terminate(outcome: DictationError | EndedEvent | null, deliver = true): void {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    active.cleanup();
    const event: EndedEvent =
      typeof outcome === "object" && outcome !== null
        ? outcome
        : {
            type: "ended",
            session: active.session,
            seq: active.seq + 1,
            reason: outcome === null ? "cancelled" : "failed",
            error: outcome,
          };
    if (deliver) this.#send(active.owner, event);
  }
  #receive(value: unknown): void {
    const parsed = DictationEventSchema.safeParse(value);
    if (!parsed.success) {
      this.options.client.disconnect();
      this.#terminate("service-unavailable");
      return;
    }
    const event = parsed.data;
    const active = this.#active;
    if (!active || event.session !== active.session || event.seq <= active.seq) return;
    if (event.seq !== active.seq + 1) {
      void this.options.client.call("cancel", active.session).catch(() => undefined);
      this.#terminate("recognition-failed");
      return;
    }
    if (event.type === "ended") {
      this.#terminate(event);
      return;
    }
    active.seq = event.seq;
    this.#send(active.owner, event);
  }
}
