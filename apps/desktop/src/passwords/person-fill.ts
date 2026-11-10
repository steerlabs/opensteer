import { randomUUID } from "node:crypto";
import { webContents } from "electron";
import { browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import type { PersonFillInput, PersonFillScope } from "@opensteer/browser-runtime-core";
import {
  personFillMaxAccounts,
  type PersonFillAccountView,
  type PersonFillSlot,
  type PersonFillStatus,
} from "@opensteer/protocol";
import type { PasswordsBrokerSignInReleaseParams } from "@opensteer/protocol/passwords-broker";
import type { DesktopPasswordsStatus } from "@opensteer/protocol/desktop";
import type { PasswordsBrokerPersonFillSession, PasswordsBrokerSession } from "./broker-session.js";

type Broker = PasswordsBrokerSession & PasswordsBrokerPersonFillSession;
type Session = PasswordsBrokerSession & Partial<PasswordsBrokerPersonFillSession>;
interface Entry {
  readonly key: string;
  readonly transactionId: string;
  readonly ended: AbortController;
  readonly dispose: (() => void)[];
  expiresAt: number;
}

export class PasswordsPersonFillAuthority {
  readonly #session: Session;
  readonly #entries = new Map<string, Entry>();
  readonly #active = new Set<Entry>();
  readonly #queues = new Map<string, Promise<PersonFillStatus>>();
  #closed = false;

  constructor(broker: PasswordsBrokerSession) {
    this.#session = broker;
  }

  /** Only a protocol 8 connection offers person fill, and a reconnect can change that. */
  get #broker(): Broker | undefined {
    const session = this.#session;
    return typeof session.fillAccounts === "function" && typeof session.fillBegin === "function"
      ? (session as Broker)
      : undefined;
  }

  statusChanged(status: DesktopPasswordsStatus): void {
    if (
      status.availability !== "available" ||
      status.broker.personFill !== "on" ||
      status.broker.vault !== "ready"
    )
      for (const entry of this.#active) void this.#end(entry, "denied");
  }

  async accounts(scope: PersonFillScope): Promise<PersonFillAccountView[]> {
    const broker = this.#broker;
    if (!broker || this.#closed) return [];
    try {
      const result = await broker.fillAccounts({ origin: scope.origin });
      if (this.#closed) return [];
      if (result.fill !== "on") {
        for (const entry of this.#active) void this.#end(entry, "denied");
        return [];
      }
      return result.accounts
        .filter((account) => scope.role !== "code" || account.hasCode)
        .slice(0, personFillMaxAccounts)
        .map(({ hasCode: _hasCode, ...account }) => ({
          ...account,
          ready: this.#live(this.#entries.get(key(scope, account.id, account.revision))),
        }));
    } catch {
      return [];
    }
  }

  async fill(input: PersonFillInput): Promise<PersonFillStatus> {
    if (!this.#broker || this.#closed) return "unavailable";
    const entryKey = key(input, input.loginId, input.revision);
    const previous = this.#queues.get(entryKey) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.#fill(input, entryKey));
    this.#queues.set(entryKey, operation);
    try {
      return await operation;
    } finally {
      if (this.#queues.get(entryKey) === operation) this.#queues.delete(entryKey);
    }
  }

  async #fill(input: PersonFillInput, entryKey: string): Promise<PersonFillStatus> {
    const broker = this.#broker;
    if (!broker || this.#closed || input.signal.aborted) return "expired";
    let entry = this.#entries.get(entryKey);
    if (!this.#live(entry)) entry = undefined;
    // An account offered as confirmed skipped the viewer's own check; once that
    // confirmation has lapsed, the person must be asked again through a new offer.
    if (!entry && input.reuseOnly) return "expired";
    if (!entry) {
      const target = webContents.fromDevToolsTargetId(input.targetId);
      if (!target || target.isDestroyed()) return "stale";
      entry = {
        key: entryKey,
        transactionId: randomUUID(),
        expiresAt: 0,
        ended: new AbortController(),
        dispose: [],
      };
      const pending = entry;
      this.#active.add(entry);
      const destroyed = () => {
        void this.#end(pending, "expired");
      };
      let targetSite: string | null;
      try {
        targetSite = browserSiteFromUrl(target.getURL());
      } catch {
        targetSite = null;
      }
      const navigated = (_event: Electron.Event, url: string) => {
        try {
          if (browserSiteFromUrl(url) !== targetSite) destroyed();
        } catch {
          destroyed();
        }
      };
      target.once("destroyed", destroyed);
      target.on("did-navigate", navigated);
      entry.dispose.push(() => {
        target.off("destroyed", destroyed);
        target.off("did-navigate", navigated);
      });
      try {
        const grant = await broker.fillBegin(
          {
            transactionId: entry.transactionId,
            loginId: input.loginId,
            revision: input.revision,
            origin: input.origin,
            presence: input.presence,
          },
          AbortSignal.any([input.signal, entry.ended.signal]),
        );
        if (input.signal.aborted || entry.ended.signal.aborted || this.#closed) {
          await this.#end(entry, "expired");
          return entry.ended.signal.reason === "denied" ? "denied" : "expired";
        }
        const decision = grant.decision;
        if (decision.decision !== "authorized") {
          await this.#end(entry, "expired");
          if (decision.decision === "unavailable") {
            if (decision.reason === "fill-off" || decision.reason === "not-set-up")
              for (const active of this.#active) void this.#end(active, "denied");
            return decision.reason === "fill-off" ? "denied" : "unavailable";
          }
          return decision.decision;
        }
        entry.expiresAt = Date.parse(decision.expiresAt);
        const lost = () => {
          void this.#end(pending, grant.lifetime.reason === "denied" ? "denied" : "expired");
        };
        grant.lifetime.addEventListener("abort", lost, { once: true });
        entry.dispose.push(() => grant.lifetime.removeEventListener("abort", lost));
        const timer = setTimeout(
          () => {
            void this.#end(pending, "expired");
          },
          Math.max(0, entry.expiresAt - Date.now()),
        );
        timer.unref();
        entry.dispose.push(() => clearTimeout(timer));
        this.#entries.set(entryKey, entry);
        if (grant.lifetime.aborted) lost();
      } catch {
        const status =
          input.signal.aborted || entry.ended.signal.aborted
            ? entry.ended.signal.reason === "denied"
              ? "denied"
              : "expired"
            : "unavailable";
        await this.#end(entry, "expired");
        return status;
      }
    }
    const signal = AbortSignal.any([input.signal, entry.ended.signal]);
    const writes: [PersonFillSlot, PasswordsBrokerSignInReleaseParams["field"]][] =
      input.role === "code"
        ? [[input.slots.group ? "group" : "target", "totp"]]
        : [["target", input.role]];
    if (input.role !== "code" && input.slots.partner)
      writes.push(["partner", input.role === "username" ? "password" : "username"]);
    try {
      for (const [slot, field] of writes) {
        if (signal.aborted || !this.#live(entry))
          return entry.ended.signal.reason === "denied" ? "denied" : "expired";
        const release = await broker.release(
          { transactionId: entry.transactionId, field, origin: input.origin, kind: "browser" },
          signal,
        );
        if (!release.released) {
          switch (release.reason) {
            case "ended":
              await this.#end(entry, "expired");
              return "expired";
            case "revoked":
            case "passwords-off":
              await this.#end(entry, "denied");
              return "denied";
            case "wrong-site":
              return "stale";
            case "no-totp":
              return "changed";
          }
        }
        try {
          if (signal.aborted || !this.#live(entry))
            return entry.ended.signal.reason === "denied" ? "denied" : "expired";
          if (!(await input.write(slot, release.value))) return "stale";
        } finally {
          release.value = "";
        }
      }
      return signal.aborted ? "expired" : "filled";
    } catch {
      return signal.aborted
        ? entry.ended.signal.reason === "denied"
          ? "denied"
          : "expired"
        : "unavailable";
    }
  }

  #live(entry: Entry | undefined): boolean {
    if (!entry || entry.ended.signal.aborted) return false;
    if (entry.expiresAt <= Date.now()) {
      void this.#end(entry, "expired");
      return false;
    }
    return true;
  }

  async #end(entry: Entry, reason: "expired" | "denied"): Promise<void> {
    if (!this.#active.delete(entry)) return;
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    entry.ended.abort(reason);
    for (const dispose of entry.dispose.splice(0)) dispose();
    await this.#session.cancel(entry.transactionId).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#active].map((entry) => this.#end(entry, "expired")));
    await Promise.allSettled(this.#queues.values());
  }
}

function key(scope: PersonFillScope, loginId: string, revision: number): string {
  return JSON.stringify([
    scope.consumerToken,
    scope.targetId,
    browserSiteFromUrl(scope.origin),
    loginId,
    revision,
    scope.presence,
  ]);
}
