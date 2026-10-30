import type { BrowserServerMessage } from "@opensteer/protocol/browser";
import type { HostCapability } from "@opensteer/deployment-authority";
import type { BrowserPasskeyMessage, PasskeyMode } from "@opensteer/protocol/passkeys";
export const passkeyNotice =
  "Passkeys work when you open this tab in the Opensteer app on your Mac";
export const passkeyAgentNotice = "An agent is working in this tab";
export interface BrowserPasskeyPort {
  readonly mode: PasskeyMode;
  present(requestId: string): Promise<void>;
}
export type BrowserPasskeyState =
  | {
      readonly kind: "offer";
      readonly requestId: string;
      readonly rpId: string;
      readonly agent: boolean;
    }
  | { readonly kind: "notice"; readonly requestId?: string }
  | null;
type Snapshot = { readonly type: "browser.snapshot"; readonly passkeys?: PasskeyMode };
/** Viewer-local passkey presentation. The desktop port receives only the Host's opaque ID. */
export class BrowserPasskeys {
  readonly #port: BrowserPasskeyPort | undefined;
  readonly #documents = new Map<string, string | undefined>();
  readonly #modes = new Map<string, PasskeyMode>();
  readonly #states = new Map<string, BrowserPasskeyState>();
  readonly #listeners = new Map<string, Set<() => void>>();
  constructor(port?: BrowserPasskeyPort) {
    this.#port = port;
  }
  optIn(capabilities: readonly HostCapability[] | null | undefined): PasskeyMode | undefined {
    return capabilities?.includes("browser-passkeys-v1")
      ? (this.#port?.mode ?? "notice")
      : undefined;
  }
  #key(sessionId: string, surfaceId: string): string {
    return JSON.stringify([sessionId, surfaceId]);
  }
  get = (sessionId: string, surfaceId: string): BrowserPasskeyState =>
    this.#states.get(this.#key(sessionId, surfaceId)) ?? null;
  subscribe = (sessionId: string, surfaceId: string, listener: () => void): (() => void) => {
    const key = this.#key(sessionId, surfaceId);
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  };
  receive(
    sessionId: string,
    surfaceId: string,
    message: BrowserServerMessage | BrowserPasskeyMessage | Snapshot,
  ): void {
    const key = this.#key(sessionId, surfaceId);
    if (message.type === "browser.surfaces.changed") {
      const documentId = message.surfaces.find((surface) => surface.id === surfaceId)?.documentId;
      if (this.#documents.get(key) !== documentId) this.#set(key, null);
      this.#documents.set(key, documentId);
      return;
    }
    if (message.type === "browser.snapshot") {
      if ("surfaces" in message)
        this.#documents.set(
          key,
          message.surfaces.find((surface) => surface.id === surfaceId)?.documentId,
        );
      if (message.passkeys) this.#modes.set(key, message.passkeys);
      else this.disconnect(sessionId, surfaceId);
      return;
    }
    const mode = this.#modes.get(key);
    if (!mode || ("surfaceId" in message && message.surfaceId !== surfaceId)) return;
    if (message.type === "browser.passkey.notice") this.#set(key, { kind: "notice" });
    if (message.type === "browser.passkey.offer")
      this.#set(
        key,
        mode === "native"
          ? {
              kind: "offer",
              requestId: message.requestId,
              rpId: message.rpId,
              agent: message.agent === true,
            }
          : { kind: "notice", requestId: message.requestId },
      );
    if (
      message.type === "browser.passkey.request" ||
      (message.type === "browser.passkey.withdrawn" &&
        this.#states.get(key)?.requestId === message.requestId)
    )
      this.#set(key, null);
  }
  async continue(sessionId: string, surfaceId: string): Promise<void> {
    const state = this.get(sessionId, surfaceId);
    if (state?.kind === "offer" && this.#port?.mode === "native")
      await this.#port.present(state.requestId);
  }
  disconnect(sessionId: string, surfaceId: string): void {
    const key = this.#key(sessionId, surfaceId);
    this.#documents.delete(key);
    this.#modes.delete(key);
    this.#set(key, null);
  }
  #set(key: string, state: BrowserPasskeyState): void {
    if (!state && !this.#states.has(key)) return;
    if (state) this.#states.set(key, state);
    else this.#states.delete(key);
    for (const listener of this.#listeners.get(key) ?? []) listener();
  }
}
