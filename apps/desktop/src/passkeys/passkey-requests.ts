import type { DesktopBrowserPresentationManager } from "../browser/browser-presentation.js";
import type { BaseWindow, WebContents } from "electron";
import { browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import {
  NormalizedPasskeyCreationOptionsJSONSchema,
  NormalizedPasskeyRequestOptionsJSONSchema,
  PasskeyOutcomeSchema,
  passkeyBytesToJSON,
  type BrowserPasskeyRequest,
  type BrowserPasskeyMessage,
} from "@opensteer/protocol/passkeys";
import { resolveRpId } from "@opensteer/browser-runtime-core/passkeys";
import { passkeyClientDataMatches } from "@opensteer/browser-runtime-core/passkey-relay";
import type {
  DesktopBrowserControlObservation,
  DesktopHostTransport,
} from "../connections/host-transport.js";
import type { NativePasskeys } from "./native-passkeys.js";
interface Socket {
  readonly ownerId: number;
  readonly sessionId: DesktopBrowserControlObservation["sessionId"];
  surfaceId: string | null;
  native: boolean;
  consumerToken: string | null;
}
type Request = Extract<
  BrowserPasskeyMessage,
  { type: "browser.passkey.request" | "browser.passkey.offer" }
>;
interface Pending {
  readonly presentation: object | "streamed";
  readonly connectionId: string;
  readonly ownerId: number;
  request: Request;
  claimed: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly controller: AbortController;
}
interface Options {
  readonly presentations: Pick<
    DesktopBrowserPresentationManager,
    "passkeyBinding" | "observePasskeyPresentation"
  >;
  readonly native: NativePasskeys;
  readonly ownOrigins: () => readonly string[];
  readonly refreshOwnOrigins?: () => Promise<void>;
  readonly windowForContents: (contents: WebContents) => BaseWindow | null;
  readonly transport: Pick<DesktopHostTransport, "observeBrowserControl" | "sendBrowserControl">;
}
/** Main owns every request before the renderer sees it, on its admitted control socket. */
export class DesktopPasskeyRequests {
  readonly #options: Options;
  readonly #sockets = new Map<string, Socket>();
  readonly #windows = new Map<number, { contents: WebContents; dispose(): void }>();
  readonly #pending = new Map<string, Pending>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribePresentation: () => void;
  constructor(options: Options) {
    this.#options = options;
    this.#unsubscribePresentation = options.presentations.observePasskeyPresentation(() => {
      for (const pending of this.#pending.values()) if (!this.#live(pending)) this.#cancel(pending);
    });
    this.#unsubscribe = options.transport.observeBrowserControl((event) => this.#observe(event));
  }
  available(): boolean {
    return this.#options.native.available();
  }
  attachWindow(window: BaseWindow & { readonly webContents: WebContents }): void {
    const contents = window.webContents;
    const cancel = () => {
      for (const pending of this.#pending.values())
        if (pending.ownerId === contents.id) this.#cancel(pending);
      for (const socket of this.#sockets.values())
        if (socket.ownerId === contents.id) socket.surfaceId = null;
    };
    const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) cancel();
    };
    const dispose = () => {
      cancel();
      contents.off("did-start-navigation", navigation);
      contents.off("render-process-gone", cancel);
      contents.off("destroyed", dispose);
      window.off("closed", dispose);
      this.#windows.delete(contents.id);
    };
    this.#windows.set(contents.id, { contents, dispose });
    contents.on("did-start-navigation", navigation);
    contents.on("render-process-gone", cancel);
    contents.once("destroyed", dispose);
    window.once("closed", dispose);
  }
  #observe(event: DesktopBrowserControlObservation): void {
    if (event.type === "admitted") {
      this.#sockets.set(event.connectionId, {
        ownerId: event.ownerId,
        sessionId: event.sessionId,
        surfaceId: null,
        native: false,
        consumerToken: null,
      });
      return;
    }
    const socket = this.#sockets.get(event.connectionId);
    if (!socket || socket.ownerId !== event.ownerId) return;
    if (event.type === "closed") {
      for (const pending of this.#pending.values())
        if (pending.connectionId === event.connectionId) this.#cancel(pending);
      this.#sockets.delete(event.connectionId);
      return;
    }
    if (event.type === "presentation") {
      socket.surfaceId = event.surfaceId;
      for (const pending of this.#pending.values())
        if (
          pending.connectionId === event.connectionId &&
          pending.request.surfaceId !== event.surfaceId
        )
          this.#cancel(pending);
      return;
    }
    if (event.type !== "message") return;
    const message = event.message;
    if (message.type === "browser.snapshot") {
      socket.native = message.passkeys === "native" && this.available();
      socket.consumerToken = message.passkeyConsumerToken ?? null;
      return;
    }
    if (message.type === "browser.passkey.withdrawn") {
      const pending = this.#pending.get(this.#key(event.connectionId, message.requestId));
      if (pending?.connectionId === event.connectionId) this.#settle(pending);
      return;
    }
    if (message.type !== "browser.passkey.request" && message.type !== "browser.passkey.offer")
      return;
    if (!socket.native && message.type === "browser.passkey.offer") return;
    const presentation = this.#options.presentations.passkeyBinding(
      event.ownerId,
      event.sessionId,
      message.surfaceId,
    );
    if (
      !socket.native ||
      presentation === null ||
      socket.surfaceId !== message.surfaceId ||
      message.deadline <= Date.now() ||
      !this.#windows.has(event.ownerId)
    ) {
      this.#send(event.ownerId, event.connectionId, {
        type: "passkey.cancel",
        requestId: message.requestId,
      });
      return;
    }
    const previous = this.#pending.get(this.#key(event.connectionId, message.requestId));
    if (previous) {
      if (
        previous.connectionId !== event.connectionId ||
        previous.request.type !== "browser.passkey.offer" ||
        !previous.claimed ||
        message.type !== "browser.passkey.request" ||
        previous.request.deadline !== message.deadline ||
        previous.request.rpId !== message.rpId ||
        previous.request.op !== message.op ||
        previous.request.surfaceId !== message.surfaceId
      )
        return;
      previous.request = message;
      void this.#perform(previous, message);
      return;
    }
    if (
      message.type === "browser.passkey.request" &&
      (typeof message.cause !== "object" || message.cause.person !== socket.consumerToken)
    ) {
      this.#send(event.ownerId, event.connectionId, {
        type: "passkey.cancel",
        requestId: message.requestId,
      });
      return;
    }
    const pending: Pending = {
      presentation,
      connectionId: event.connectionId,
      ownerId: event.ownerId,
      request: message,
      claimed: false,
      controller: new AbortController(),
      timer: setTimeout(
        () => this.#cancel(pending),
        Math.max(0, Math.min(600_000, message.deadline - Date.now())),
      ),
    };
    pending.timer.unref();
    this.#pending.set(this.#key(event.connectionId, message.requestId), pending);
    if (message.type === "browser.passkey.request") void this.#perform(pending, message);
  }
  async present(contents: WebContents, requestId: string): Promise<void> {
    const matches = [...this.#pending.values()].filter(
      (request) => request.ownerId === contents.id && request.request.requestId === requestId,
    );
    const pending = matches.length === 1 ? matches[0] : undefined;
    if (
      !pending ||
      pending.ownerId !== contents.id ||
      this.#windows.get(contents.id)?.contents !== contents ||
      !this.#live(pending) ||
      !this.#window(contents)
    )
      throw new Error("This passkey request is no longer presented.");
    if (pending.request.type === "browser.passkey.offer" && !pending.claimed) {
      pending.claimed = true;
      if (!this.#send(contents.id, pending.connectionId, { type: "passkey.claim", requestId })) {
        this.#settle(pending);
        throw new Error("The passkey connection ended.");
      }
    }
  }
  #key(connectionId: string, requestId: string): string {
    return JSON.stringify([connectionId, requestId]);
  }
  #window(contents: WebContents): BaseWindow | null {
    const window = this.#options.windowForContents(contents);
    return window && !window.isDestroyed() ? window : null;
  }
  #live(pending: Pending): boolean {
    const socket = this.#sockets.get(pending.connectionId);
    return (
      this.#pending.get(this.#key(pending.connectionId, pending.request.requestId)) === pending &&
      socket?.native === true &&
      this.#options.presentations.passkeyBinding(
        pending.ownerId,
        socket.sessionId,
        pending.request.surfaceId,
      ) === pending.presentation &&
      socket.surfaceId === pending.request.surfaceId &&
      Date.now() < pending.request.deadline
    );
  }
  async #perform(pending: Pending, request: BrowserPasskeyRequest): Promise<void> {
    try {
      if (this.#options.refreshOwnOrigins) await this.#options.refreshOwnOrigins();
      const contents = this.#windows.get(pending.ownerId)?.contents;
      const window = contents && this.#window(contents);
      if (
        !window ||
        !this.#live(pending) ||
        this.#options
          .ownOrigins()
          .some((own) => browserSiteFromUrl(own) === browserSiteFromUrl(request.origin))
      ) {
        this.#cancel(pending);
        return;
      }
      const resolved = resolveRpId(request.origin, request.rpId);
      if ("error" in resolved || resolved.rpId !== request.rpId) {
        this.#cancel(pending);
        return;
      }
      const common = {
        operationId: request.requestId,
        rpId: request.rpId,
        origin: request.origin,
        deadline: request.deadline,
        window,
      };
      const input =
        request.op === "create"
          ? {
              ...common,
              op: "create" as const,
              options: NormalizedPasskeyCreationOptionsJSONSchema.parse(request.options),
            }
          : {
              ...common,
              op: "get" as const,
              options: NormalizedPasskeyRequestOptionsJSONSchema.parse(request.options),
            };
      const outcome = await this.#options.native.perform(input, pending.controller.signal);
      if (!this.#live(pending)) return;
      const wire = PasskeyOutcomeSchema.parse(
        passkeyBytesToJSON(
          passkeyClientDataMatches(input, outcome)
            ? outcome
            : { kind: "refused", error: "NotAllowedError" },
        ),
      );
      this.#settle(pending);
      this.#send(pending.ownerId, pending.connectionId, {
        type: "passkey.respond",
        requestId: request.requestId,
        outcome: wire,
      });
    } catch {
      this.#cancel(pending);
    }
  }
  #send(
    ownerId: number,
    connectionId: string,
    message: Parameters<DesktopHostTransport["sendBrowserControl"]>[2],
  ): boolean {
    try {
      this.#options.transport.sendBrowserControl(ownerId, connectionId, message);
      return true;
    } catch {
      return false;
    }
  }
  #settle(pending: Pending): void {
    if (this.#pending.get(this.#key(pending.connectionId, pending.request.requestId)) !== pending)
      return;
    this.#pending.delete(this.#key(pending.connectionId, pending.request.requestId));
    clearTimeout(pending.timer);
    pending.controller.abort();
  }
  #cancel(pending: Pending): void {
    if (!this.#pending.has(this.#key(pending.connectionId, pending.request.requestId))) return;
    this.#settle(pending);
    this.#send(pending.ownerId, pending.connectionId, {
      type: "passkey.cancel",
      requestId: pending.request.requestId,
    });
  }
  dispose(): void {
    this.#unsubscribe();
    this.#unsubscribePresentation();
    for (const pending of this.#pending.values()) this.#cancel(pending);
    for (const window of this.#windows.values()) window.dispose();
    this.#sockets.clear();
  }
}
