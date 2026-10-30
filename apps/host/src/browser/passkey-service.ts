import { browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import { randomUUID } from "node:crypto";
import type {
  BrowserPasskeyMessage,
  PasskeyCeremony,
  PasskeyMode,
  PasskeyOutcome,
  PasskeyViewerMessage,
} from "@opensteer/protocol/passkeys";

export interface PasskeyViewer {
  readonly token: string;
  userId: string | null;
  fullControl: boolean;
  mode: PasskeyMode | undefined;
  surfaceId: string | null;
  live: boolean;
  authorized(): Promise<boolean>;
  send(message: BrowserPasskeyMessage): void;
}
interface PasskeyServiceOptions {
  ownOrigins(): readonly string[];
  viewers(): readonly PasskeyViewer[];
  result(message: { type: "passkey.result"; ceremonyId: string; outcome: PasskeyOutcome }): void;
}
interface Pending {
  readonly requestId: string;
  readonly ceremony: PasskeyCeremony;
  readonly offered: Set<string>;
  readonly ended: PromiseWithResolvers<void>;
  readonly timer: ReturnType<typeof setTimeout>;
  consumer: string | null;
  answering: boolean;
}
const refused: PasskeyOutcome = { kind: "refused", error: "NotAllowedError" };
/** One runtime connection generation and session. Requests never travel between instances. */
export class PasskeyService {
  readonly #options: PasskeyServiceOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #seen = new Set<string>();
  #closed = false;
  constructor(options: PasskeyServiceOptions) {
    this.#options = options;
  }
  #eligible(viewer: PasskeyViewer, surfaceId: string): boolean {
    return (
      viewer.live &&
      viewer.userId !== null &&
      viewer.fullControl &&
      viewer.mode !== undefined &&
      viewer.surfaceId === surfaceId
    );
  }
  ceremony(ceremony: PasskeyCeremony): void {
    if (this.#closed) {
      this.#options.result({
        type: "passkey.result",
        ceremonyId: ceremony.ceremonyId,
        outcome: refused,
      });
      return;
    }
    if (this.#seen.has(ceremony.ceremonyId)) return;
    this.#seen.add(ceremony.ceremonyId);
    // Bound memory for a long-lived connection; a runtime must rotate before exhausting it.
    if (this.#seen.size > 4096) {
      this.close();
      this.#options.result({
        type: "passkey.result",
        ceremonyId: ceremony.ceremonyId,
        outcome: refused,
      });
      return;
    }
    for (const pending of this.#pending.values())
      if (pending.ceremony.surfaceId === ceremony.surfaceId) this.#finish(pending, refused);
    const reject = () =>
      this.#options.result({
        type: "passkey.result",
        ceremonyId: ceremony.ceremonyId,
        outcome: refused,
      });
    if (
      ceremony.deadline <= Date.now() ||
      ceremony.deadline > Date.now() + 600_000 ||
      this.#options.ownOrigins().some((origin) => {
        try {
          return browserSiteFromUrl(origin) === browserSiteFromUrl(ceremony.origin);
        } catch {
          return true;
        }
      })
    ) {
      reject();
      return;
    }
    const viewers = this.#options
      .viewers()
      .filter((viewer) => this.#eligible(viewer, ceremony.surfaceId));
    const person =
      typeof ceremony.cause === "object"
        ? viewers.find(
            (viewer) =>
              viewer.token ===
              (typeof ceremony.cause === "object" ? ceremony.cause.person : undefined),
          )
        : undefined;
    if (typeof ceremony.cause === "object" && (!person || person.mode === "notice")) {
      person?.send({ type: "browser.passkey.notice", surfaceId: ceremony.surfaceId });
      reject();
      return;
    }
    if (viewers.length === 0) {
      reject();
      return;
    }
    const requestId = randomUUID();
    const pending: Pending = {
      requestId,
      ceremony,
      offered: new Set(person ? [person.token] : viewers.map((viewer) => viewer.token)),
      ended: Promise.withResolvers<void>(),
      consumer: person?.token ?? null,
      answering: false,
      timer: setTimeout(
        () => this.#finish(pending, refused),
        Math.max(0, ceremony.deadline - Date.now()),
      ),
    };
    pending.timer.unref();
    this.#pending.set(requestId, pending);
    if (person) this.#request(pending, person);
    else
      for (const viewer of viewers)
        viewer.send({
          type: "browser.passkey.offer",
          requestId,
          surfaceId: ceremony.surfaceId,
          rpId: ceremony.rpId,
          op: ceremony.op,
          deadline: ceremony.deadline,
          ...(ceremony.cause === "agent" ? { agent: true } : {}),
        });
  }
  async viewer(token: string, message: PasskeyViewerMessage): Promise<void> {
    const pending = this.#pending.get(message.requestId);
    if (pending && message.type === "passkey.cancel") {
      if (pending.consumer === token) this.#finish(pending, refused);
      else if (pending.consumer === null && pending.offered.delete(token)) {
        this.#options
          .viewers()
          .find((viewer) => viewer.token === token)
          ?.send({ type: "browser.passkey.withdrawn", requestId: pending.requestId });
        this.refresh();
      }
      return;
    }
    if (!pending || pending.answering || pending.ceremony.deadline <= Date.now()) {
      if (pending && pending.ceremony.deadline <= Date.now()) this.#finish(pending, refused);
      return;
    }
    const viewer = this.#options.viewers().find((viewer) => viewer.token === token);
    if (
      !viewer ||
      !pending.offered.has(token) ||
      !this.#eligible(viewer, pending.ceremony.surfaceId)
    )
      return;
    if (message.type === "passkey.claim") {
      // Claim before any await: simultaneous claims cannot both reach a sheet.
      if (pending.consumer !== null || viewer.mode !== "native") return;
      pending.consumer = token;
      if (!(await this.#authorized(viewer, pending)) || !this.#current(pending, viewer)) {
        this.#finish(pending, refused);
        return;
      }
      for (const other of this.#options.viewers())
        if (other.token !== token && pending.offered.has(other.token))
          other.send({ type: "browser.passkey.withdrawn", requestId: pending.requestId });
      this.#request(pending, viewer);
      return;
    }
    if (pending.consumer !== token) return;
    pending.answering = true;
    const authorized = await this.#authorized(viewer, pending);
    this.#finish(
      pending,
      authorized && this.#current(pending, viewer) && message.type === "passkey.respond"
        ? message.outcome
        : refused,
    );
  }
  async #authorized(viewer: PasskeyViewer, pending: Pending): Promise<boolean> {
    try {
      return await Promise.race([viewer.authorized(), pending.ended.promise.then(() => false)]);
    } catch {
      return false;
    }
  }
  #current(pending: Pending, viewer: PasskeyViewer): boolean {
    return (
      this.#pending.get(pending.requestId) === pending &&
      this.#eligible(viewer, pending.ceremony.surfaceId) &&
      Date.now() < pending.ceremony.deadline
    );
  }
  #request(pending: Pending, viewer: PasskeyViewer): void {
    viewer.send({
      ...pending.ceremony,
      type: "browser.passkey.request",
      requestId: pending.requestId,
    });
  }
  documentChanged(surfaceId: string): void {
    for (const pending of this.#pending.values())
      if (pending.ceremony.surfaceId === surfaceId) this.#finish(pending, refused);
  }
  cancel(ceremonyId: string): void {
    for (const pending of this.#pending.values())
      if (pending.ceremony.ceremonyId === ceremonyId) this.#finish(pending, refused);
  }
  refresh(): void {
    for (const pending of this.#pending.values()) {
      const eligible = this.#options
        .viewers()
        .filter(
          (viewer) =>
            pending.offered.has(viewer.token) && this.#eligible(viewer, pending.ceremony.surfaceId),
        );
      if (
        pending.consumer
          ? !eligible.some((viewer) => viewer.token === pending.consumer)
          : eligible.length === 0
      )
        this.#finish(pending, refused);
    }
  }
  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) this.#finish(pending, refused);
  }
  #finish(pending: Pending, outcome: PasskeyOutcome): void {
    if (!this.#pending.delete(pending.requestId)) return;
    pending.ended.resolve();
    clearTimeout(pending.timer);
    for (const viewer of this.#options.viewers())
      if (pending.offered.has(viewer.token))
        viewer.send({ type: "browser.passkey.withdrawn", requestId: pending.requestId });
    this.#options.result({
      type: "passkey.result",
      ceremonyId: pending.ceremony.ceremonyId,
      outcome: Date.now() < pending.ceremony.deadline ? outcome : refused,
    });
  }
}
