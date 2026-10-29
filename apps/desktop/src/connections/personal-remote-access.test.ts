import { createId } from "@opensteer/core";
import {
  ConnectOperationIdSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/control-plane-protocol";
import {
  PersonalRemoteAccessStatusSchema,
  type PersonalRemoteAccessStatus,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import type { PersonalHostConnectOrchestrator } from "../supervisor/personal-host-connect-orchestrator.js";
import type { DesktopPersonalAccountLinkCoordinator } from "../account/personal-account-link.js";
import { DesktopPersonalAccountMutationCoordinator } from "../account/personal-account-mutation.js";
import {
  DesktopPersonalRemoteAccessService,
  type PersonalHostConnectComponents,
} from "./personal-remote-access.js";
import { type PersonalHostRuntimeRecord } from "../supervisor/personal-host-runtime.js";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";

describe("DesktopPersonalRemoteAccessService", () => {
  it("commits Host Off before revoking the external Connect resource", async () => {
    const fixture = remoteAccessFixture();
    await fixture.service.configure({ mode: "connect", privateOrigin: null });
    fixture.events.splice(0);

    const result = await fixture.service.configure({ mode: "off", privateOrigin: null });

    expect(fixture.events).toEqual(["host:disable:connect:2", "connect:disable:74"]);
    expect(result).toMatchObject({ generation: 2, mode: "off", phase: "off" });
  });

  it("commits Host Off before reconciling stale Connect teardown while already Off", async () => {
    const fixture = remoteAccessFixture();
    const service = initializationService(fixture, {
      management: null,
      teardown: teardownSpy(fixture.events),
    });

    await expect(service.configure({ mode: "off", privateOrigin: null })).resolves.toMatchObject({
      mode: "off",
      phase: "off",
    });
    expect(fixture.events).toEqual(["host:disable:off:1", "teardown:if-present"]);
  });

  it("quiesces management before re-committing Host Off and reconciling teardown", async () => {
    const fixture = remoteAccessFixture();
    const service = initializationService(fixture, {
      management: {
        quiesce: async () => {
          fixture.events.push("management:quiesce");
          fixture.host.commitConnect();
        },
      } as never,
      teardown: teardownSpy(fixture.events),
    });

    await expect(service.configure({ mode: "off", privateOrigin: null })).resolves.toMatchObject({
      mode: "off",
      phase: "off",
    });
    expect(fixture.events).toEqual([
      "management:quiesce",
      "host:connect:1",
      "host:disable:connect:2",
      "teardown:if-present",
    ]);
  });

  it("keeps Host Off and retries stale teardown after a cleanup failure", async () => {
    const fixture = remoteAccessFixture();
    let attempt = 0;
    const service = initializationService(fixture, {
      management: null,
      teardown: {
        reconcileIfPresent: async () => {
          attempt += 1;
          fixture.events.push(`teardown:attempt:${attempt}`);
          if (attempt === 1) throw new Error("The revoke response was lost.");
          return true;
        },
        stopConnector: async () => undefined,
      } as never,
    });

    await expect(service.configure({ mode: "off", privateOrigin: null })).rejects.toThrow(
      /response was lost/u,
    );
    await expect(fixture.host.status()).resolves.toMatchObject({ mode: "off" });
    expect(service.status).toMatchObject({ mode: "off", phase: "error", retryable: true });

    await expect(service.configure({ mode: "off", privateOrigin: null })).resolves.toMatchObject({
      mode: "off",
      phase: "off",
    });
    expect(fixture.events).toEqual([
      "host:disable:off:1",
      "teardown:attempt:1",
      "host:disable:off:2",
      "teardown:attempt:2",
    ]);
  });

  it("keeps Host route and connector credentials independently fenced through Private -> Off -> Connect", async () => {
    const fixture = remoteAccessFixture();
    await fixture.host.configureConnectPrivate("https://home.tailnet.test");
    fixture.events.splice(0);

    await expect(
      fixture.service.configure({ mode: "off", privateOrigin: null }),
    ).resolves.toMatchObject({ generation: 2, mode: "off" });
    await expect(
      fixture.service.configure({ mode: "connect", privateOrigin: null }),
    ).resolves.toMatchObject({ generation: 3, mode: "connect", phase: "ready" });

    expect(fixture.events).toEqual([
      "host:disable:private:2",
      "link:ensure",
      "connect:enable:57",
      "host:connect:3",
    ]);
    expect(fixture.host.routeHistory).toEqual([
      { generation: 1, kind: "private" },
      { generation: 3, kind: "connect" },
    ]);
    expect(fixture.connect.credentialHistory).toEqual([{ action: "enable", generation: 57 }]);
    expect(fixture.host.generation).toBe(3);
    expect(fixture.connect.credentialGeneration).toBe(57);
  });

  it("revokes each active route before switching Connect -> Private -> Connect without equating generations", async () => {
    const fixture = remoteAccessFixture();

    await fixture.service.configure({ mode: "connect", privateOrigin: null });
    await fixture.service.configure({
      mode: "private",
      privateOrigin: "https://home.tailnet.test",
    });
    await fixture.service.configure({ mode: "connect", privateOrigin: null });

    expect(fixture.events).toEqual([
      "link:ensure",
      "connect:enable:57",
      "host:connect:1",
      "host:disable:connect:2",
      "connect:disable:74",
      "host:private:3",
      "link:ensure",
      "host:disable:private:4",
      "connect:enable:91",
      "host:connect:5",
    ]);
    expect(fixture.host.routeHistory).toEqual([
      { generation: 1, kind: "connect" },
      { generation: 3, kind: "private" },
      { generation: 5, kind: "connect" },
    ]);
    expect(fixture.connect.credentialHistory).toEqual([
      { action: "enable", generation: 57 },
      { action: "disable", generation: 74 },
      { action: "enable", generation: 91 },
    ]);
    expect(fixture.service.status).toMatchObject({
      generation: 5,
      mode: "connect",
      phase: "ready",
      routeOrigin: "https://home.connect.test",
    });
    expect(fixture.host.generation).not.toBe(fixture.connect.credentialGeneration);
  });

  it("rejects Connect queued during unlink and leaves no Connect resource after unlink completes", async () => {
    const mutations = new DesktopPersonalAccountMutationCoordinator();
    const fixture = remoteAccessFixture(mutations);
    let releaseUnlink!: () => void;
    const unlinkPaused = new Promise<void>((resolve) => {
      releaseUnlink = resolve;
    });
    let unlinkStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      unlinkStarted = resolve;
    });
    const unlink = mutations.run("unlink", async () => {
      unlinkStarted();
      await unlinkPaused;
      await fixture.connect.revokeResourceForUnlink();
    });
    await started;

    await expect(
      fixture.service.configure({ mode: "connect", privateOrigin: null }),
    ).rejects.toMatchObject({ code: "personal-account-unlink-in-progress" });
    expect(fixture.connect.credentialHistory).toEqual([]);

    releaseUnlink();
    await unlink;
    expect(fixture.connect.credentialHistory).toEqual([]);
  });

  it("keeps Host-owned teardown available when Account Connect management is unavailable", async () => {
    const fixture = remoteAccessFixture();
    const operationId = ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
    const revoked: string[] = [];
    const service = new DesktopPersonalRemoteAccessService({
      auth: {
        accountAuthorizationHeader: async () => "Bearer account",
        beginAccountSignIn: async () => undefined as never,
      },
      connectFactory: () => ({
        management: null,
        teardown: {
          revokeResourceForUnlink: async (input: string) => void revoked.push(input),
        } as never,
      }),
      connectUnavailableDetail: "Opensteer Connect is disabled in this source build.",
      host: fixture.host,
      link: fixture.link as unknown as DesktopPersonalAccountLinkCoordinator,
      runtime: { current: async () => fixture.runtime },
    });

    await expect(service.revokeConnectResourceForUnlink(operationId)).resolves.toBeUndefined();
    expect(revoked).toEqual([operationId]);
    await expect(service.configure({ mode: "connect", privateOrigin: null })).rejects.toThrow(
      "disabled in this source build",
    );
  });

  it.each([
    { result: "disabled" as const, expectedMode: "off" as const },
    { result: "enabled" as const, expectedMode: "connect" as const },
  ])(
    "reconciles durable Connect $result intent while the Host is Off",
    async ({ expectedMode, result }) => {
      const fixture = remoteAccessFixture();
      const calls: string[] = [];
      fixture.host.accountLinked = true;
      const service = initializationService(fixture, {
        management: {
          reconcile: async () => {
            calls.push(`management:${result}`);
            if (result === "enabled") fixture.host.commitConnect();
            return { detail: null, state: result };
          },
        } as never,
        teardown: teardownSpy(calls),
      });

      await expect(service.initialize()).resolves.toMatchObject({ mode: expectedMode });
      expect(calls).toEqual([`management:${result}`]);
    },
  );

  it("cleans stale Connect intent on startup without overwriting a Private route", async () => {
    const fixture = remoteAccessFixture();
    const calls: string[] = [];
    await fixture.host.configureConnectPrivate("https://home.tailnet.test");
    const service = initializationService(fixture, {
      management: { reconcile: async () => void calls.push("management") } as never,
      teardown: teardownSpy(calls),
    });

    await expect(service.initialize()).resolves.toMatchObject({
      mode: "private",
      routeOrigin: "https://home.tailnet.test",
    });
    expect(calls).toEqual(["teardown:if-present"]);
  });

  it("never resurrects Connect in a build without Account management", async () => {
    const fixture = remoteAccessFixture();
    const calls: string[] = [];
    fixture.host.accountLinked = true;
    fixture.host.commitConnect();
    fixture.events.splice(0);
    const service = initializationService(fixture, {
      management: null,
      teardown: teardownSpy(calls),
    });

    await expect(service.initialize()).resolves.toMatchObject({ mode: "off" });
    expect(fixture.events).toEqual(["host:disable:connect:2"]);
    expect(calls).toEqual(["teardown:disable"]);
  });

  it("quiesces an in-flight management reconciliation before unlink checks the Host route", async () => {
    const fixture = remoteAccessFixture();
    const calls: string[] = [];
    fixture.host.accountLinked = true;
    const service = initializationService(fixture, {
      management: {
        quiesce: async () => {
          calls.push("management:quiesce");
          // Represents an earlier queued reconciliation committing Connect
          // before the serialized quiesce boundary gets ownership.
          fixture.host.commitConnect();
        },
      } as never,
      teardown: teardownSpy(calls),
    });

    await expect(service.disableConnectForUnlink()).resolves.toMatchObject({ mode: "off" });
    expect(calls).toEqual(["management:quiesce"]);
    expect(fixture.events.slice(-2)).toEqual(["host:connect:1", "host:disable:connect:2"]);
  });
});

function initializationService(
  fixture: ReturnType<typeof remoteAccessFixture>,
  components: PersonalHostConnectComponents,
) {
  return new DesktopPersonalRemoteAccessService({
    auth: {
      accountAuthorizationHeader: async () => "Bearer account",
      beginAccountSignIn: async () => undefined as never,
    },
    connectFactory: () => components,
    host: fixture.host,
    link: fixture.link as unknown as DesktopPersonalAccountLinkCoordinator,
    runtime: { current: async () => fixture.runtime },
  });
}

function teardownSpy(calls: string[]) {
  return {
    disable: async () => void calls.push("teardown:disable"),
    reconcileIfPresent: async () => {
      calls.push("teardown:if-present");
      return true;
    },
    revokeResourceForUnlink: async () => undefined,
    stopConnector: async () => undefined,
  } as never;
}

function remoteAccessFixture(mutations?: DesktopPersonalAccountMutationCoordinator) {
  const events: string[] = [];
  const runtime = personalRuntime();
  const host = new StatefulRemoteHost(runtime, events);
  const connect = new IndependentConnectLifecycle(host, events);
  const link = new FakeAccountLink(host, events);
  const service = new DesktopPersonalRemoteAccessService({
    auth: {
      accountAuthorizationHeader: async () => "Bearer account",
      beginAccountSignIn: async () => undefined as never,
    },
    connectFactory: () => ({
      management: connect as unknown as PersonalHostConnectOrchestrator,
      teardown: connect as never,
    }),
    host,
    link: link as unknown as DesktopPersonalAccountLinkCoordinator,
    ...(mutations ? { mutations } : {}),
    runtime: { current: async () => runtime },
  });
  return { connect, events, host, link, runtime, service };
}

class FakeAccountLink {
  readonly #events: string[];
  readonly #host: StatefulRemoteHost;

  constructor(host: StatefulRemoteHost, events: string[]) {
    this.#events = events;
    this.#host = host;
  }

  async ensureLinkedForMutation(): Promise<never> {
    this.#events.push("link:ensure");
    this.#host.accountLinked = true;
    return undefined as never;
  }

  async state(): Promise<null> {
    return null;
  }
}

class StatefulRemoteHost {
  accountLinked = false;
  generation = 0;
  readonly routeHistory: Array<{
    readonly generation: number;
    readonly kind: "connect" | "private";
  }> = [];
  readonly #authority: PersonalHostRuntimeRecord;
  readonly #events: string[];
  #mode: "connect" | "off" | "private" = "off";
  #route: PersonalHostAccessRouteEnvelope | null = null;

  constructor(authority: PersonalHostRuntimeRecord, events: string[]) {
    this.#authority = authority;
    this.#events = events;
  }

  async status(): Promise<PersonalRemoteAccessStatus> {
    return this.#status();
  }

  async disableConnect(): Promise<void> {
    const previous = this.#mode;
    this.generation += 1;
    this.#events.push(`host:disable:${previous}:${this.generation}`);
    this.#mode = "off";
    this.#route = null;
  }

  async configureConnectPrivate(origin: string): Promise<PersonalRemoteAccessStatus> {
    this.generation += 1;
    this.#events.push(`host:private:${this.generation}`);
    this.#mode = "private";
    this.#route = routeEnvelope(this.#authority, "private", this.generation, origin);
    this.routeHistory.push({ generation: this.generation, kind: "private" });
    return this.#status();
  }

  async configureConnect(origin: string): Promise<PersonalHostAccessRouteEnvelope> {
    this.#commitConnect(origin);
    return this.#route!;
  }

  async issuePairingCode(): Promise<never> {
    return undefined as never;
  }

  commitConnect(): void {
    this.#commitConnect("https://home.connect.test");
  }

  #commitConnect(origin: string): void {
    this.generation += 1;
    this.#events.push(`host:connect:${this.generation}`);
    this.#mode = "connect";
    this.#route = routeEnvelope(this.#authority, "connect", this.generation, origin);
    this.routeHistory.push({ generation: this.generation, kind: "connect" });
  }

  #status(): PersonalRemoteAccessStatus {
    return PersonalRemoteAccessStatusSchema.parse({
      accountLink: this.accountLinked
        ? {
            generation: "g".repeat(43),
            issuer: "https://account.opensteer.test",
            state: "active",
            subject: "acct_00000000-0000-4000-8000-000000000000",
          }
        : null,
      generation: this.generation,
      mode: this.#mode,
      route: this.#route,
      schemaVersion: 2,
    });
  }
}

class IndependentConnectLifecycle {
  credentialGeneration = 40;
  readonly credentialHistory: Array<{
    readonly action: "disable" | "enable";
    readonly generation: number;
  }> = [];
  readonly #events: string[];
  readonly #host: StatefulRemoteHost;

  constructor(host: StatefulRemoteHost, events: string[]) {
    this.#host = host;
    this.#events = events;
  }

  async enable(): Promise<never> {
    this.credentialGeneration += 17;
    this.credentialHistory.push({ action: "enable", generation: this.credentialGeneration });
    this.#events.push(`connect:enable:${this.credentialGeneration}`);
    this.#host.commitConnect();
    return { generation: this.credentialGeneration, state: "enabled" } as never;
  }

  async disable(): Promise<never> {
    this.credentialGeneration += 17;
    this.credentialHistory.push({ action: "disable", generation: this.credentialGeneration });
    this.#events.push(`connect:disable:${this.credentialGeneration}`);
    return { generation: null, state: "disabled" } as never;
  }

  async reconcile(): Promise<never> {
    return { generation: this.credentialGeneration, state: "enabled" } as never;
  }

  async quiesce(): Promise<void> {}

  async reconcileIfPresent(): Promise<boolean> {
    return false;
  }

  async revokeResourceForUnlink(): Promise<void> {
    this.credentialHistory.splice(0);
  }

  async shutdown(): Promise<void> {}
}

function personalRuntime(): PersonalHostRuntimeRecord {
  return testPersonalHostRuntime({
    discovery: {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    },
    localOrigin: "http://127.0.0.1:4310",
    observedAt: "2026-08-12T12:00:00.000Z",
    ownership: "desktop-personal-host-supervisor",
    schemaVersion: 1,
    state: "ready",
    verification: "signed-loopback-discovery",
  });
}

function routeEnvelope(
  runtime: PersonalHostRuntimeRecord,
  kind: "connect" | "private",
  generation: number,
  origin: string,
): PersonalHostAccessRouteEnvelope {
  return PersonalHostAccessRouteEnvelopeSchema.parse({
    document: {
      authority: runtime.discovery,
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: { generation, kind, origin },
    },
    publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
    schemaVersion: 1,
    signature: "A".repeat(86),
  });
}
