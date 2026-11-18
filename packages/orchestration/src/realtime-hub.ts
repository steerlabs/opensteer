import type { AuthSessionId, ThreadId, UserId } from "@opensteer/core";
import type { HostToClientMessage } from "@opensteer/protocol";
import type { PersonalScope } from "@opensteer/protocol/personal-sync";
import type {
  LiveDeliveryOptions,
  PersonalSyncSocket,
  PersonalLiveUpdate,
} from "./personal-sync.js";

export interface RealtimeSink {
  readonly id: string;
  send(message: HostToClientMessage): Promise<void>;
  close(code: number, reason: string): void;
}

interface Connection {
  readonly userId: UserId;
  readonly sessionId: AuthSessionId;
  readonly sink: RealtimeSink;
  readonly sync: PersonalSyncSocket;
}

export class RealtimeHub {
  readonly #connections = new Set<Connection>();
  readonly #observers = new Set<(notice: HostToClientMessage) => void>();
  readonly #scopeObservers = new Set<{ scopes: readonly string[]; wake: () => void }>();
  readonly #reads = new Set<{ readonly scopes: readonly string[]; invalid: boolean }>();
  readonly #suspended = new Map<
    ReadonlySet<string>,
    ReturnType<PersonalSyncSocket["suspendAuthority"]>[]
  >();
  #head = "0";

  observe(listener: (notice: HostToClientMessage) => void): () => void {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  }

  observeScopes(scopes: readonly string[], wake: () => void) {
    const listener = { scopes, wake };
    this.#scopeObservers.add(listener);
    return () => this.#scopeObservers.delete(listener);
  }

  registerConnection(connection: Connection): () => void {
    this.#connections.add(connection);
    for (const [scope, pending] of this.#suspended)
      pending.push(connection.sync.suspendAuthority(scope));
    connection.sync.wake(this.#head);
    return () => this.#connections.delete(connection);
  }

  wake(head: string, changedScopes: ReadonlySet<string> = new Set()): void {
    if (BigInt(head) > BigInt(this.#head)) {
      this.#head = head;
      for (const { sync } of this.#connections) sync.wake(head);
    }
    for (const observer of this.#scopeObservers)
      if (
        changedScopes.has("deployment") ||
        observer.scopes.some((scope) => changedScopes.has(scope))
      )
        observer.wake();
  }

  guardRead(scopes: readonly string[]) {
    const read = { scopes, invalid: false };
    this.#reads.add(read);
    return {
      current: () =>
        !read.invalid &&
        ![...this.#suspended.keys()].some(
          (pending) => pending.has("deployment") || scopes.some((scope) => pending.has(scope)),
        ),
      release: () => this.#reads.delete(read),
    };
  }

  suspendAuthority(scopes: ReadonlySet<string>) {
    const paused = [...this.#connections].map(({ sync }) => sync.suspendAuthority(scopes));
    this.#suspended.set(scopes, paused);
    return {
      committed: () => {
        for (const read of this.#reads) {
          if (scopes.has("deployment") || read.scopes.some((scope) => scopes.has(scope)))
            read.invalid = true;
        }
        for (const suspension of paused) suspension.committed();
        this.#suspended.delete(scopes);
      },
      rolledBack: () => {
        this.#suspended.delete(scopes);
        for (const suspension of paused) suspension.rolledBack();
      },
    };
  }

  closeSession(sessionId: AuthSessionId): void {
    for (const read of this.#reads) {
      if (read.scopes.includes(`session:${sessionId}`)) read.invalid = true;
    }
    for (const connection of this.#connections) {
      if (connection.sessionId === sessionId) this.#closeConnection(connection, "Session ended");
    }
  }

  closeUser(userId: UserId): void {
    for (const connection of this.#connections) {
      if (connection.userId === userId)
        this.#closeConnection(connection, "Deployment access revoked");
    }
  }

  #closeConnection(connection: Connection, reason: string) {
    this.#connections.delete(connection);
    connection.sink.close(4003, reason);
    connection.sync.close(reason);
  }

  closeAll(reason = "Personal Host closed"): void {
    for (const { sync } of this.#connections) sync.close(reason);
  }

  connectedUserIds(): readonly UserId[] {
    return [...new Set([...this.#connections].map(({ userId }) => userId))];
  }

  sendToUsers(userIds: Iterable<UserId>, message: HostToClientMessage): void {
    this.#deliver(new Set(userIds), message);
  }

  broadcast(message: HostToClientMessage): void {
    this.#deliver(null, message);
  }

  #deliver(viewers: ReadonlySet<UserId> | null, message: HostToClientMessage): void {
    for (const observer of this.#observers) observer(message);
    for (const { sink, sync, userId } of this.#connections) {
      if (sync.attached && (!viewers || viewers.has(userId)))
        void sink.send(message).catch(() => sink.close(1011, "Personal notice delivery failed"));
    }
  }

  async showToPerson(
    userId: UserId,
    message: Extract<HostToClientMessage, { type: "host.show" }>,
  ): Promise<number> {
    const deliveries = [...this.#connections]
      .filter((entry) => entry.userId === userId && entry.sync.attached)
      .map(({ sink }) =>
        sink.send(message).then(
          () => true,
          () => false,
        ),
      );
    return (await Promise.all(deliveries)).filter(Boolean).length;
  }

  publishLive(
    scope: Exclude<PersonalScope, { kind: "shell" }>,
    update: PersonalLiveUpdate,
    options?: LiveDeliveryOptions,
  ): void {
    for (const { sync } of this.#connections) sync.offerLive(scope, update, options);
  }

  publishConnectionsChanged(userId: UserId): void {
    this.sendToUsers([userId], { type: "host.connections-changed" });
  }

  publishTriggersChanged(): void {
    this.broadcast({ type: "host.triggers-changed" });
  }

  publishBrowserUsageChanged(threadIds: readonly ThreadId[]): void {
    for (const { sink, sync } of this.#connections) {
      const interested = [...new Set(threadIds)].filter((id) => sync.observesThread(id));
      if (interested.length === 0) continue;
      void sink
        .send({ type: "host.browser-usage-changed", threadIds: interested.slice(0, 100) })
        .catch(() => sink.close(1011, "Browser usage notice failed"));
    }
  }
}
