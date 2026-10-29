import { createHash, randomBytes } from "node:crypto";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { createIntegrationId } from "@opensteer/integration-core";
import type {
  IntegrationAuthAttemptFailureReason,
  IntegrationAuthAttemptStore,
} from "@opensteer/integration-core/ports";
import { createId } from "@opensteer/core";
import { erasedIntegrationAuthAttemptPayload } from "@opensteer/database";
import { describe, expect, it } from "vitest";
import {
  DefaultIntegrationAuthAttemptLifecycle,
  integrationAuthAttemptLifetimeMilliseconds,
} from "./integration-auth-attempt-service.js";

describe("DefaultIntegrationAuthAttemptLifecycle", () => {
  it("stores only digests and a sealed launch destination with the shared TTL", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const store = new MemoryAttemptStore();
    const lifecycle = lifecycleWith(store, now);
    const ownerUserId = createId("user");
    const id = createIntegrationId("oauthAttempt");
    let preparedState = "";
    const started = await lifecycle.begin({
      flow: "provider-oauth",
      id,
      ownerUserId,
      payload: async (generatedState) => {
        preparedState = generatedState;
        return {
          authorizationUrl: `https://accounts.example.test/authorize?state=${generatedState}`,
          payload: { secret: "sealed-value" },
        };
      },
      surface: "desktop",
    });

    expect(started.state).toBe(preparedState);
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(started.launchTicket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(store.created).toMatchObject({
      expiresAt: new Date(now.getTime() + integrationAuthAttemptLifetimeMilliseconds),
      flow: "provider-oauth",
      id,
      launchTicketHash: digest(started.launchTicket),
      ownerUserId,
      stateHash: digest(started.state),
      surface: "desktop",
    });
    expect(store.created?.stateHash).not.toBe(started.state);
    expect(store.created?.launchTicketHash).not.toBe(started.launchTicket);
    expect(store.created?.encryptedPayload.toString("utf8")).not.toContain("sealed-value");
    expect(store.created?.encryptedPayload.toString("utf8")).not.toContain("accounts.example");
    await expect(lifecycle.status({ id, ownerUserId })).resolves.toMatchObject({
      connectionId: null,
      status: "pending",
    });
  });

  it("launches and claims exactly once with both browser binding and state", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const store = new MemoryAttemptStore();
    const lifecycle = lifecycleWith(store, now);
    const ownerUserId = createId("user");
    const id = createIntegrationId("mcpOauthAttempt");
    const started = await lifecycle.begin({
      flow: "mcp-oauth",
      id,
      ownerUserId,
      payload: async (state) => ({
        authorizationUrl: `https://accounts.example.test/authorize?state=${state}`,
        payload: { payload: "flow-specific" },
      }),
      surface: "web",
    });

    await expect(lifecycle.launch({ id, launchTicket: "x".repeat(43) })).resolves.toBeNull();
    const launched = await lifecycle.launch({ id, launchTicket: started.launchTicket });
    expect(launched).toMatchObject({ flow: "mcp-oauth", id, surface: "web" });
    expect(launched?.authorizationUrl).toContain(`state=${started.state}`);
    await expect(
      lifecycle.claim({
        browserBinding: "x".repeat(43),
        flow: "mcp-oauth",
        id,
        state: started.state,
      }),
    ).resolves.toBeNull();
    await expect(
      lifecycle.claim({
        browserBinding: launched!.browserBinding,
        flow: "provider-oauth",
        id,
        state: started.state,
      }),
    ).resolves.toBeNull();
    await expect(
      lifecycle.claim({
        browserBinding: launched!.browserBinding,
        flow: "mcp-oauth",
        id,
        state: started.state,
      }),
    ).resolves.toEqual({
      id,
      ownerUserId,
      payload: { payload: "flow-specific" },
      surface: "web",
    });
    await expect(
      lifecycle.claim({
        browserBinding: launched!.browserBinding,
        flow: "mcp-oauth",
        id,
        state: started.state,
      }),
    ).resolves.toBeNull();
  });

  it("reports no payload once a terminal attempt has had its context erased", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const store = new MemoryAttemptStore();
    const lifecycle = lifecycleWith(store, now);
    const ownerUserId = createId("user");
    const id = createIntegrationId("oauthAttempt");
    const started = await lifecycle.begin({
      flow: "provider-oauth",
      id,
      ownerUserId,
      payload: async (state) => ({
        authorizationUrl: `https://accounts.example.test/authorize?state=${state}`,
        payload: { codeVerifier: "pkce-verifier" },
      }),
      surface: "web",
    });
    const launched = await lifecycle.launch({ id, launchTicket: started.launchTicket });
    await expect(lifecycle.inspect({ id, ownerUserId })).resolves.toEqual({
      codeVerifier: "pkce-verifier",
    });

    await lifecycle.fail(id, "denied");

    await expect(lifecycle.inspect({ id, ownerUserId })).resolves.toBeNull();
    await expect(
      lifecycle.claim({
        browserBinding: launched!.browserBinding,
        flow: "provider-oauth",
        id,
        state: started.state,
      }),
    ).resolves.toBeNull();
  });

  it("reports no payload after the owner cancels an authorization attempt", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const store = new MemoryAttemptStore();
    const lifecycle = lifecycleWith(store, now);
    const ownerUserId = createId("user");
    const id = createIntegrationId("oauthAttempt");
    await lifecycle.begin({
      flow: "provider-oauth",
      id,
      ownerUserId,
      payload: async (state) => ({
        authorizationUrl: `https://accounts.example.test/authorize?state=${state}`,
        payload: { codeVerifier: "pkce-verifier" },
      }),
      surface: "web",
    });

    await expect(lifecycle.cancel({ id, ownerUserId })).resolves.toBe(true);

    await expect(lifecycle.inspect({ id, ownerUserId })).resolves.toBeNull();
  });

  it("reports a durable typed failure when the provider identity belongs to another user", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const store = new MemoryAttemptStore();
    const lifecycle = lifecycleWith(store, now);
    const ownerUserId = createId("user");
    const id = createIntegrationId("oauthAttempt");
    await lifecycle.begin({
      flow: "provider-oauth",
      id,
      ownerUserId,
      payload: async () => ({
        authorizationUrl: "https://accounts.example.test/authorize",
        payload: { codeVerifier: "pkce-verifier" },
      }),
      surface: "web",
    });

    await lifecycle.fail(id, "provider-identity-already-connected");

    await expect(lifecycle.status({ id, ownerUserId })).resolves.toMatchObject({
      failureCode: "provider-identity-already-connected",
      status: "failed",
    });
  });

  it.each([
    "account-link-mismatch",
    "authorization-denied",
    "catalog-version-skew",
    "client-rejected",
    "grant-rejected",
    "invalid-provider-response",
    "provider-exchange-failed",
    "scope-escalation",
    "stale-provider-application",
  ] as const)("preserves the safe broker failure code %s", async (failureCode) => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const store = new MemoryAttemptStore();
    const lifecycle = lifecycleWith(store, now);
    const ownerUserId = createId("user");
    const id = createIntegrationId("oauthAttempt");
    await lifecycle.begin({
      flow: "provider-oauth",
      id,
      ownerUserId,
      payload: async () => ({
        authorizationUrl: "https://accounts.example.test/authorize",
        payload: { codeVerifier: "pkce-verifier" },
      }),
      surface: "web",
    });

    await lifecycle.fail(id, failureCode);

    await expect(lifecycle.status({ id, ownerUserId })).resolves.toMatchObject({
      failureCode,
      status: "failed",
    });
  });

  it("maps a durable remote expiry to expired and keeps the first terminal result", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const store = new MemoryAttemptStore();
    const lifecycle = lifecycleWith(store, now);
    const ownerUserId = createId("user");
    const id = createIntegrationId("oauthAttempt");
    await lifecycle.begin({
      flow: "provider-oauth",
      id,
      ownerUserId,
      payload: async () => ({
        authorizationUrl: "https://accounts.example.test/authorize",
        payload: {},
      }),
      surface: "web",
    });

    await lifecycle.fail(id, "expired");
    await lifecycle.fail(id, "provider-exchange-failed");

    await expect(lifecycle.status({ id, ownerUserId })).resolves.toMatchObject({
      failureCode: null,
      status: "expired",
    });
  });
});

function lifecycleWith(store: IntegrationAuthAttemptStore, now: Date) {
  return new DefaultIntegrationAuthAttemptLifecycle({
    now: () => now,
    store,
    vault: new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
    ),
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

class MemoryAttemptStore implements IntegrationAuthAttemptStore {
  created: Parameters<IntegrationAuthAttemptStore["createAuthAttempt"]>[0] | undefined;
  #browserBindingHash: string | null = null;
  #failureReason: IntegrationAuthAttemptFailureReason | null = null;
  #status: "claimed" | "completed" | "failed" | "launched" | "pending" | undefined;

  async createAuthAttempt(input: Parameters<IntegrationAuthAttemptStore["createAuthAttempt"]>[0]) {
    this.created = input;
    this.#status = "pending";
  }

  async launchAuthAttempt(input: Parameters<IntegrationAuthAttemptStore["launchAuthAttempt"]>[0]) {
    const created = this.created;
    if (
      !created ||
      this.#status !== "pending" ||
      created.expiresAt <= input.now ||
      created.id !== input.id ||
      created.launchTicketHash !== input.launchTicketHash
    ) {
      return null;
    }
    this.#browserBindingHash = input.browserBindingHash;
    this.#status = "launched";
    return {
      encryptedPayload: created.encryptedPayload,
      encryptionKeyVersion: created.encryptionKeyVersion,
      flow: created.flow,
      id: created.id,
      ownerUserId: created.ownerUserId,
      surface: created.surface,
    };
  }

  async claimAuthAttempt(input: Parameters<IntegrationAuthAttemptStore["claimAuthAttempt"]>[0]) {
    const created = this.created;
    if (
      !created ||
      this.#status !== "launched" ||
      created.expiresAt <= input.now ||
      created.flow !== input.flow ||
      created.id !== input.id ||
      this.#browserBindingHash !== input.browserBindingHash ||
      created.stateHash !== input.stateHash
    ) {
      return null;
    }
    this.#status = "claimed";
    return {
      encryptedPayload: created.encryptedPayload,
      encryptionKeyVersion: created.encryptionKeyVersion,
      id: created.id,
      ownerUserId: created.ownerUserId,
      surface: created.surface,
    };
  }

  async cancelAuthAttempt(input: Parameters<IntegrationAuthAttemptStore["cancelAuthAttempt"]>[0]) {
    if (
      !this.created ||
      this.created.id !== input.id ||
      this.created.ownerUserId !== input.ownerUserId ||
      (this.#status !== "pending" && this.#status !== "launched")
    ) {
      return false;
    }
    this.created = { ...this.created, encryptedPayload: erasedIntegrationAuthAttemptPayload };
    this.#failureReason = "cancelled";
    this.#status = "failed";
    return true;
  }

  async failAuthAttempt(input: Parameters<IntegrationAuthAttemptStore["failAuthAttempt"]>[0]) {
    if (
      this.created?.id !== input.id ||
      (this.#status !== "pending" && this.#status !== "launched" && this.#status !== "claimed")
    ) {
      return;
    }
    this.created = { ...this.created, encryptedPayload: erasedIntegrationAuthAttemptPayload };
    this.#failureReason = input.reason;
    this.#status = "failed";
  }

  async readAuthAttemptPayload(
    input: Parameters<NonNullable<IntegrationAuthAttemptStore["readAuthAttemptPayload"]>>[0],
  ) {
    const created = this.created;
    return created && created.id === input.id && created.ownerUserId === input.ownerUserId
      ? {
          encryptedPayload: created.encryptedPayload,
          encryptionKeyVersion: created.encryptionKeyVersion,
          id: created.id,
          ownerUserId: created.ownerUserId,
          surface: created.surface,
        }
      : null;
  }

  async deleteExpiredAuthAttempts(now: Date) {
    if (this.created && this.created.expiresAt <= now) {
      this.created = undefined;
      this.#status = undefined;
    }
  }

  async findAuthAttemptForCallback(
    input: Parameters<IntegrationAuthAttemptStore["findAuthAttemptForCallback"]>[0],
  ) {
    const created = this.created;
    return created &&
      this.#status === "launched" &&
      created.flow === input.flow &&
      created.stateHash === input.stateHash &&
      created.expiresAt > input.now
      ? { id: created.id }
      : null;
  }

  async getAuthAttempt(input: Parameters<IntegrationAuthAttemptStore["getAuthAttempt"]>[0]) {
    const created = this.created;
    return created &&
      this.#status &&
      created.id === input.id &&
      created.ownerUserId === input.ownerUserId
      ? {
          expiresAt: created.expiresAt,
          failureReason: this.#failureReason,
          id: created.id,
          ownerUserId: created.ownerUserId,
          resultConnectionId: null,
          status: this.#status,
          surface: created.surface,
        }
      : null;
  }
}
