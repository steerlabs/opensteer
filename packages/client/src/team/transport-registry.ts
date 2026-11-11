import { teamFileTransport } from "./files.js";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { DeploymentIdSchema } from "@opensteer/core";
import {
  HostTransport,
  type HostTransportOptions,
  type HostNetworkSocket,
} from "../connections/host-transport.js";
import { createHttpHostApiClient } from "../host/host-api-client.js";
import type { WebSocketClient } from "../host/host-session-client.js";
import { TeamSessionClient, type TeamSessionOptions } from "./team-session-client.js";
import { teamCacheKey, type TeamCacheScope } from "./persistence.js";

export function pinnedTeamTransport(
  options: HostTransportOptions & {
    readonly deploymentId: NonNullable<HostTransportOptions["deploymentId"]>;
  },
  baseUrl: URL,
) {
  const transport = new HostTransport({ ...options, expectedKind: "team" });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== baseUrl.origin) throw new Error("Team request left its pinned origin.");
    const headers = new Headers(init?.headers);
    return transport.exchange(
      {
        path: url.pathname + url.search,
        method: init?.method ?? "GET",
        expectedDeploymentId: options.deploymentId,
        headers: { additional: Object.fromEntries(headers.entries()) },
        ...(init?.signal ? { signal: init.signal } : {}),
        ...(typeof init?.body === "string" || init?.body instanceof Blob
          ? { body: init.body }
          : {}),
      },
      async (response, progress) => {
        const bytes = await readBoundedResponse(response, {
          maximumBytes: 16 * 1024 * 1024,
          signal: progress.signal,
          onProgress: progress.onProgress,
          sizeError: () => new Error("Team response exceeds its byte bound."),
        });
        return new Response(Uint8Array.from(bytes), {
          status: response.status,
          headers: response.headers,
        });
      },
    );
  };
  const rpc = createHttpHostApiClient({
    baseUrl,
    fetch,
    kind: "team",
    onAuthenticationRequired: () => transport.closeAllSockets(),
  });
  const connect = (): WebSocketClient => {
    let readyState = 0,
      network: HostNetworkSocket | null = null;
    const listeners = new Map<string, Set<(event: never) => void>>();
    const pending: string[] = [];
    function emit(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event as never);
    }
    const socket: WebSocketClient = {
      binaryType: "arraybuffer",
      get readyState() {
        return readyState;
      },
      addEventListener(type, listener) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener as (event: never) => void);
        listeners.set(type, set);
      },
      close(code, reason) {
        readyState = 3;
        pending.length = 0;
        network?.close(code, reason);
      },
      send(data) {
        if (typeof data !== "string") throw new Error("Team sync frames are text.");
        if (network) network.send(data);
        else {
          if (pending.length >= 10) throw new Error("Team socket is not ready.");
          pending.push(data);
        }
      },
    };
    void transport
      .openSocket({ path: "/v1/realtime" }, () => ({
        open: () => {
          if (readyState === 3) return;
          readyState = 1;
          emit("open", {});
        },
        close: (code, reason) => {
          readyState = 3;
          emit("close", { code, reason });
        },
        error: (message) => emit("error", { message }),
        message: (data) => emit("message", { data }),
      }))
      .then((connected) => {
        network = connected;
        if (readyState === 3) connected.close();
        else for (const frame of pending.splice(0)) connected.send(frame);
      })
      .catch(() => {
        readyState = 3;
        emit("close", {});
      });
    return socket;
  };
  return {
    transport,
    rpc,
    connect,
    files: (scope: TeamCacheScope) => teamFileTransport(transport, scope),
  };
}
export class TeamTransportRegistry {
  readonly #clients = new Map<string, TeamSessionClient>();
  readonly #removing = new Map<string, Promise<void>>();
  readonly #platform: "desktop" | "mobile" | "web";
  readonly #create: (scope: TeamCacheScope) => TeamSessionOptions;
  #selected: string | null = null;
  #selectionGeneration = 0;
  #disposed = false;
  constructor(
    platform: "desktop" | "mobile" | "web",
    create: (scope: TeamCacheScope) => TeamSessionOptions,
  ) {
    this.#platform = platform;
    this.#create = create;
  }
  async join(scope: TeamCacheScope): Promise<TeamSessionClient> {
    if (this.#disposed) throw new Error("Team registry disposed.");
    const key = teamCacheKey(scope);
    await this.#removing.get(key);
    if (this.#disposed) throw new Error("Team registry disposed.");
    const held = this.#clients.get(key);
    if (held) {
      if (this.#platform !== "mobile" || this.#selected === key) await held.load(false);
      return held;
    }
    DeploymentIdSchema.parse(scope.teamDeploymentId);
    const client = new TeamSessionClient(this.#create(scope));
    this.#clients.set(key, client);
    try {
      if (this.#platform !== "mobile" || this.#selected === key) {
        await client.load(false);
        if (
          this.#clients.get(key) === client &&
          (this.#platform !== "mobile" || this.#selected === key)
        )
          client.connect();
      }
    } catch (error) {
      if (this.#clients.get(key) === client) this.#clients.delete(key);
      client.dispose();
      throw error;
    }
    return client;
  }
  async select(scope: TeamCacheScope | null): Promise<void> {
    const generation = ++this.#selectionGeneration;
    this.#selected = scope ? teamCacheKey(scope) : null;
    for (const [key, client] of this.#clients) {
      if (key !== this.#selected) client.selectChannel(null);
      if (this.#platform === "mobile" && key !== this.#selected) {
        client.disconnect();
        continue;
      }
      if (!client.getSnapshot().bootstrap) await client.load(false);
      if (generation !== this.#selectionGeneration || this.#disposed) return;
      if (this.#clients.get(key) === client) client.connect();
    }
  }
  async remove(scope: TeamCacheScope): Promise<void> {
    const key = teamCacheKey(scope),
      pending = this.#removing.get(key);
    if (pending) return pending;
    const client = this.#clients.get(key);
    this.#clients.delete(key);
    const operation = client ? client.remove() : this.#create(scope).persistence.remove(scope);
    this.#removing.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.#removing.get(key) === operation) this.#removing.delete(key);
    }
  }
  async logout(userId: string): Promise<void> {
    for (const [key] of this.#clients) {
      const [teamDeploymentId, user] = JSON.parse(key) as [string, string];
      if (user === userId) await this.remove({ teamDeploymentId, userId });
    }
  }
  dispose(): void {
    this.#disposed = true;
    this.#selectionGeneration++;
    for (const client of this.#clients.values()) client.dispose();
    this.#clients.clear();
  }
}
