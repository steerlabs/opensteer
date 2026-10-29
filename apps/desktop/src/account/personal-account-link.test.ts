import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@opensteer/core";
import {
  CompletePersonalHostAccountLinkResponseSchema,
  AccountLinkGenerationSchema,
  ConnectOperationIdSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  PersonalHostAccountLinkOperationIdSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  type CompletePersonalHostAccountLinkResponse,
  type IssuePersonalHostAccountLinkChallengeRequest,
  type IssuePersonalHostAccountLinkChallengeResponse,
  type PersonalHostAccountLinkChallengeId,
  type PersonalHostAccountLinkChallengeCredential,
  type PersonalHostAccountLinkCompletionGrant,
  type PersonalHostAccountLinkProofEnvelope,
} from "@opensteer/control-plane-protocol";
import type { PersonalRemoteAccessStatus } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  DesktopPersonalAccountLinkStore,
  DesktopPersonalAccountLinkStateSchema,
  type DesktopPersonalAccountLinkState,
} from "./personal-account-link-store.js";
import { desktopPersonalAccountLinkSecretsPath } from "../app/application-paths.js";
import {
  DesktopPersonalAccountLinkCoordinator,
  type PersonalAccountLinkControlPlane,
} from "./personal-account-link.js";
import {
  PersonalHostRuntimeRecordSchema,
  type PersonalHostRuntimeRecord,
} from "../supervisor/personal-host-runtime.js";
import type { DesktopSecretCryptography } from "../secrets/protected-json-file.js";
import { PersonalHostAccountLinkCompletionGrantRejectedError } from "../supervisor/personal-host-control.js";
import { AccountRequestError } from "@opensteer/client/connections";

const unlinkPrefix = [
  "disable-connect",
  "revoke-account-sessions",
  "revoke-connect-resource",
] as const;

describe("DesktopPersonalAccountLinkStore", () => {
  it("refuses to discard incompatible critical operation state", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-link-store-"));
    try {
      const deploymentId = createId("deployment");
      const cryptography = testCryptography();
      const filePath = desktopPersonalAccountLinkSecretsPath(dataDirectory, deploymentId);
      await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
      const encrypted = await cryptography.encryptStringAsync(
        JSON.stringify({
          authority: { discovery: { protocol: { maximum: 1, minimum: 1 } } },
          schemaVersion: 2,
        }),
      );
      await writeFile(
        filePath,
        `${JSON.stringify({ ciphertext: encrypted.toString("base64"), schemaVersion: 1 })}\n`,
        { mode: 0o600 },
      );
      const store = new DesktopPersonalAccountLinkStore({ cryptography, dataDirectory });

      await expect(store.load(deploymentId)).rejects.toThrow("incompatible or corrupt");
      await expect(lstat(filePath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });

  it("reports a journal from an unknown schema as repairable and keeps the evidence", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-link-store-"));
    try {
      const runtime = personalRuntime();
      const cryptography = testCryptography();
      const filePath = desktopPersonalAccountLinkSecretsPath(
        dataDirectory,
        runtime.discovery.deploymentId,
      );
      await writeProtectedLinkState(dataDirectory, runtime, cryptography, {
        account: null,
        authority: runtime,
        displayName: "This computer",
        schemaVersion: 3,
      });
      const store = new DesktopPersonalAccountLinkStore({ cryptography, dataDirectory });

      await expect(store.inspect(runtime.discovery.deploymentId, runtime, null)).resolves.toEqual({
        journal: null,
        status: "needs-repair",
      });
      await expect(lstat(filePath)).resolves.toMatchObject({ isFile: expect.any(Function) });
      // A mutation still fails closed rather than acting on state it cannot read.
      await expect(
        store.reconcileForMutation(runtime.discovery.deploymentId, runtime, null),
      ).rejects.toThrow("incompatible or corrupt");
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });

  it("infers the Host-unlink boundary on mutation but never writes it on inspection", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-link-store-"));
    try {
      const runtime = personalRuntime();
      const store = new DesktopPersonalAccountLinkStore({
        cryptography: testCryptography(),
        dataDirectory,
      });
      const journal = await store.save(runtime.discovery.deploymentId, {
        authority: runtime,
        issueOperationId: null,
        operation: null,
        schemaVersion: 4,
        unlinkOperation: {
          completedSteps: ["disable-connect", "revoke-account-sessions", "revoke-connect-resource"],
          connectRevokeOperationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
          startedAt: "2026-08-12T12:00:00.000Z",
        },
      });

      await expect(
        store.inspect(runtime.discovery.deploymentId, runtime, null),
      ).resolves.toMatchObject({
        journal: { unlinkOperation: { completedSteps: [...unlinkPrefix, "remove-host-link"] } },
        status: "ready",
      });
      await expect(store.load(runtime.discovery.deploymentId)).resolves.toEqual(journal);

      await expect(
        store.reconcileForMutation(runtime.discovery.deploymentId, runtime, null),
      ).resolves.toMatchObject({
        journal: { unlinkOperation: { completedSteps: [...unlinkPrefix, "remove-host-link"] } },
        status: "ready",
      });
      await expect(store.load(runtime.discovery.deploymentId)).resolves.toMatchObject({
        unlinkOperation: { completedSteps: [...unlinkPrefix, "remove-host-link"] },
      });
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });

  it("does not infer Host unlink before all preceding v4 steps are durable", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-link-store-"));
    try {
      const runtime = personalRuntime();
      const store = new DesktopPersonalAccountLinkStore({
        cryptography: testCryptography(),
        dataDirectory,
      });
      const journal = await store.save(runtime.discovery.deploymentId, {
        authority: runtime,
        issueOperationId: null,
        operation: null,
        schemaVersion: 4,
        unlinkOperation: {
          completedSteps: ["disable-connect"],
          connectRevokeOperationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
          startedAt: "2026-08-12T12:00:00.000Z",
        },
      });

      await expect(
        store.reconcileForMutation(runtime.discovery.deploymentId, runtime, null),
      ).resolves.toEqual({ journal: null, status: "needs-repair" });
      await expect(store.load(runtime.discovery.deploymentId)).resolves.toEqual(journal);
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });

  it("rejects an out-of-order unlink journal instead of skipping authority boundaries", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-link-store-"));
    try {
      const runtime = personalRuntime();
      const cryptography = testCryptography();
      const store = new DesktopPersonalAccountLinkStore({ cryptography, dataDirectory });
      const state = DesktopPersonalAccountLinkStateSchema.parse({
        authority: runtime,
        operation: null,
        schemaVersion: 4,
        unlinkOperation: {
          completedSteps: ["revoke-connect-resource"],
          connectRevokeOperationId: `cop_${crypto.randomUUID()}`,
          startedAt: "2026-08-12T12:00:00.000Z",
        },
      });
      await store.save(runtime.discovery.deploymentId, state);

      await expect(
        store.reconcileForMutation(runtime.discovery.deploymentId, runtime, null),
      ).resolves.toEqual({ journal: null, status: "needs-repair" });
      await expect(store.load(runtime.discovery.deploymentId)).resolves.toEqual(state);
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });
});

describe("DesktopPersonalAccountLinkCoordinator", () => {
  it.each(["signed-out", "different-account"] as const)(
    "delivers a durable completion while %s without refreshing it through Account",
    async (identityKind) => {
      const fixture = await recoveryFixture(identityKind, "accept");

      await expect(fixture.coordinator.ensureLinked()).resolves.toMatchObject({ operation: null });
      expect(fixture.host.consumeCalls).toHaveLength(1);
      expect(fixture.account.completeCalls).toBe(0);
      await expect(fixture.store.load(fixture.runtime.discovery.deploymentId)).resolves.toBeNull();
    },
  );

  it.each(["signed-out", "different-account"] as const)(
    "requires the original Account after explicit grant rejection while %s",
    async (identityKind) => {
      const fixture = await recoveryFixture(identityKind, "reject-grant");

      await expect(fixture.coordinator.ensureLinked()).rejects.toMatchObject({
        code: "personal-account-link-original-account-required",
      });
      expect(fixture.account.completeCalls).toBe(0);
      await expect(
        fixture.store.load(fixture.runtime.discovery.deploymentId),
      ).resolves.toMatchObject({
        operation: {
          challenge: fixture.challenge,
          completion: fixture.completion,
          proof: fixture.proof,
        },
      });
    },
  );

  it("refreshes an explicitly rejected grant only for the original Account", async () => {
    const fixture = await recoveryFixture("original-account", "reject-once");

    await expect(fixture.coordinator.ensureLinked()).resolves.toMatchObject({
      operation: null,
    });
    expect(fixture.host.consumeCalls).toHaveLength(2);
    expect(fixture.account.completeCalls).toBe(1);
    await expect(fixture.store.load(fixture.runtime.discovery.deploymentId)).resolves.toBeNull();
  });

  it("preserves durable completion on transient Host failure without Account refresh", async () => {
    const fixture = await recoveryFixture("original-account", "transient");

    await expect(fixture.coordinator.ensureLinked()).rejects.toThrow(
      "Host temporarily unavailable",
    );
    expect(fixture.account.identityCalls).toBe(0);
    expect(fixture.account.completeCalls).toBe(0);
    await expect(fixture.store.load(fixture.runtime.discovery.deploymentId)).resolves.toMatchObject(
      {
        operation: { completion: fixture.completion },
      },
    );
  });

  it("replays durable Host consumption after a lost activation response", async () => {
    const runtime = personalRuntime();
    const challenge = accountLinkChallenge(runtime);
    const proof = accountLinkProof(challenge);
    const completion = accountLinkCompletion();
    const store = new DurableMemoryLinkStore();
    const account = new LostResponseAccount(challenge, completion);
    const host = new IdempotentLostResponseHost(proof);
    const coordinator = (now: string) =>
      new DesktopPersonalAccountLinkCoordinator({
        account,
        host,
        manifest: {
          load: async () =>
            ({ deploymentId: runtime.discovery.deploymentId, name: "This computer" }) as never,
          save: async (_previous, next) => next,
        },
        now: () => new Date(now),
        runtime: { current: async () => runtime },
        store,
      });

    // The Host commits the one-use completion grant, but its response is lost.
    await expect(coordinator("2026-08-12T12:00:00.000Z").ensureLinked()).rejects.toThrow(
      "Host consume response was lost",
    );
    expect(await store.load(runtime.discovery.deploymentId)).toMatchObject({
      operation: { challenge, completion, proof },
    });

    // A fresh Desktop process replays the exact durable transcript. Host
    // consume owns idempotent central activation, so no Account bearer is used.
    await expect(coordinator("2026-08-12T12:06:00.000Z").ensureLinked()).resolves.toMatchObject({
      operation: null,
    });
    await expect(store.load(runtime.discovery.deploymentId)).resolves.toBeNull();

    expect(account.issueCalls).toEqual([
      {
        authorityEnvelope: runtime.discoveryEnvelope,
        name: "This computer",
        operationId: expect.stringMatching(/^plo_/u),
      },
    ]);
    expect(account.completeCalls).toEqual(
      Array.from({ length: 1 }, () => ({
        challengeId: challenge.challengeId,
        input: {
          challengeCredential: challenge.challengeCredential,
          proof,
        },
      })),
    );
    expect(host.approveCalls).toEqual([{ challenge, runtime }]);
    expect(host.consumeCalls).toEqual([
      {
        completionGrant: completion.completionGrant,
        hostCredential: completion.hostCredential,
        linkGeneration: completion.linkGeneration,
        runtime,
      },
      {
        completionGrant: completion.completionGrant,
        hostCredential: completion.hostCredential,
        linkGeneration: completion.linkGeneration,
        runtime,
      },
    ]);

    const completionPersisted = store.snapshots.find(
      (state) => state.operation?.completion?.completionGrant === completion.completionGrant,
    );
    expect(completionPersisted).toBeDefined();
  });

  it("reuses the durable operation ID after an issue response is lost", async () => {
    const runtime = personalRuntime();
    const challenge = accountLinkChallenge(runtime);
    const proof = accountLinkProof(challenge);
    const account = new LostResponseAccount(challenge, accountLinkCompletion());
    account.loseFirstIssueResponse = true;
    const host = new IdempotentLostResponseHost(proof);
    const store = new DurableMemoryLinkStore();
    const coordinator = new DesktopPersonalAccountLinkCoordinator({
      account,
      host,
      manifest: {
        load: async () =>
          ({ deploymentId: runtime.discovery.deploymentId, name: "This computer" }) as never,
        save: async (_previous, next) => next,
      },
      runtime: { current: async () => runtime },
      store,
    });

    await expect(coordinator.ensureLinked()).rejects.toThrow("issue response was lost");
    await expect(coordinator.ensureLinked()).rejects.toThrow("Host consume response was lost");
    expect(account.issueCalls).toHaveLength(2);
    expect(account.issueCalls[1]?.operationId).toBe(account.issueCalls[0]?.operationId);
    await expect(store.load(runtime.discovery.deploymentId)).resolves.toMatchObject({
      issueOperationId: null,
      operation: { challenge },
    });
  });

  it("finishes a still-valid challenge instead of racing its central reservation", async () => {
    const runtime = personalRuntime();
    const challenge = accountLinkChallenge(runtime);
    const proof = accountLinkProof(challenge);
    const completion = accountLinkCompletion();
    const store = new DurableMemoryLinkStore();
    await store.save(runtime.discovery.deploymentId, {
      authority: runtime,
      issueOperationId: null,
      operation: {
        challenge,
        completion: null,
        operationId: PersonalHostAccountLinkOperationIdSchema.parse(`plo_${crypto.randomUUID()}`),
        proof,
      },
      schemaVersion: 4,
      unlinkOperation: null,
    });
    const account = new RecoveryAccount(challenge.account, completion);
    const coordinator = new DesktopPersonalAccountLinkCoordinator({
      account,
      host: new RecoveryHost(challenge, completion, "accept"),
      manifest: {
        load: async () =>
          ({ deploymentId: runtime.discovery.deploymentId, name: "This computer" }) as never,
        save: async (_previous, next) => next,
      },
      now: () => new Date("2026-08-12T12:04:56.000Z"),
      runtime: { current: async () => runtime },
      store,
    });

    await expect(coordinator.ensureLinked()).resolves.toMatchObject({ operation: null });
    expect(account.completeCalls).toBe(1);
  });

  it("reports the state that survives a Host-driven resume, not the journal it cleared", async () => {
    const runtime = personalRuntime();
    const challenge = accountLinkChallenge(runtime);
    const completion = accountLinkCompletion();
    const store = new DurableMemoryLinkStore();
    await store.save(runtime.discovery.deploymentId, {
      authority: runtime,
      issueOperationId: PersonalHostAccountLinkOperationIdSchema.parse(
        `plo_${crypto.randomUUID()}`,
      ),
      operation: null,
      schemaVersion: 4,
      unlinkOperation: null,
    });
    const host = new RecoveryHost(challenge, completion, "accept");
    host.linkState = "activating";
    const coordinator = new DesktopPersonalAccountLinkCoordinator({
      account: new RecoveryAccount(challenge.account, completion),
      host,
      manifest: {
        load: async () =>
          ({ deploymentId: runtime.discovery.deploymentId, name: "This computer" }) as never,
        save: async (_previous, next) => next,
      },
      runtime: { current: async () => runtime },
      store,
    });

    await expect(coordinator.ensureLinked()).resolves.toEqual({
      authority: runtime,
      issueOperationId: null,
      operation: null,
      schemaVersion: 4,
      unlinkOperation: null,
    });
    expect(host.resumeCalls).toBe(1);
    await expect(store.load(runtime.discovery.deploymentId)).resolves.toBeNull();
  });

  it("restarts an expired challenge exactly once instead of looping on the Account", async () => {
    const runtime = personalRuntime();
    const challenge = accountLinkChallenge(runtime);
    const store = new DurableMemoryLinkStore();
    const expired = new AccountRequestError({
      code: "conflict",
      message: "challenge expired",
      reason: "personal-account-link-challenge-expired",
      status: 409,
    });
    let issued = 0;
    const account = {
      accountOrigin: "https://accounts.opensteer.test",
      accountIdentity: async () => challenge.account,
      completePersonalHostAccountLink: async () => {
        throw expired;
      },
      issuePersonalHostAccountLinkChallenge: async () => {
        issued += 1;
        return structuredClone(challenge);
      },
    };
    const coordinator = new DesktopPersonalAccountLinkCoordinator({
      account,
      host: new IdempotentLostResponseHost(accountLinkProof(challenge)),
      manifest: {
        load: async () =>
          ({ deploymentId: runtime.discovery.deploymentId, name: "This computer" }) as never,
        save: async (_previous, next) => next,
      },
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      runtime: { current: async () => runtime },
      store,
    });

    await expect(coordinator.ensureLinked()).rejects.toBe(expired);
    expect(issued).toBe(2);
  });

  it("fails closed with a stable code while a durable unlink is incomplete", async () => {
    const runtime = personalRuntime();
    const challenge = accountLinkChallenge(runtime);
    const completion = accountLinkCompletion();
    const store = new DurableMemoryLinkStore();
    await store.save(
      runtime.discovery.deploymentId,
      DesktopPersonalAccountLinkStateSchema.parse({
        authority: runtime,
        operation: null,
        schemaVersion: 4,
        unlinkOperation: {
          completedSteps: ["disable-connect"],
          connectRevokeOperationId: `cop_${crypto.randomUUID()}`,
          startedAt: "2026-08-12T12:00:00.000Z",
        },
      }),
    );
    const account = new LostResponseAccount(challenge, completion);
    const coordinator = new DesktopPersonalAccountLinkCoordinator({
      account,
      host: new IdempotentLostResponseHost(accountLinkProof(challenge)),
      manifest: {
        load: async () =>
          ({ deploymentId: runtime.discovery.deploymentId, name: "This computer" }) as never,
        save: async (_previous, next) => next,
      },
      runtime: { current: async () => runtime },
      store,
    });

    await expect(coordinator.ensureLinked()).rejects.toMatchObject({
      code: "personal-account-unlink-in-progress",
    });
    expect(account.issueCalls).toEqual([]);
    expect(account.completeCalls).toEqual([]);
  });
});

async function recoveryFixture(
  identityKind: "different-account" | "original-account" | "signed-out",
  outcome: "accept" | "reject-grant" | "reject-once" | "transient",
) {
  const runtime = personalRuntime();
  const challenge = accountLinkChallenge(runtime);
  const proof = accountLinkProof(challenge);
  const completion = accountLinkCompletion();
  const store = new DurableMemoryLinkStore();
  await store.save(runtime.discovery.deploymentId, {
    authority: runtime,
    issueOperationId: null,
    operation: {
      challenge,
      completion,
      operationId: PersonalHostAccountLinkOperationIdSchema.parse(`plo_${crypto.randomUUID()}`),
      proof,
    },
    schemaVersion: 4,
    unlinkOperation: null,
  });
  const identity =
    identityKind === "signed-out"
      ? null
      : identityKind === "original-account"
        ? challenge.account
        : {
            ...challenge.account,
            issuer: "https://different-account.opensteer.test",
          };
  const account = new RecoveryAccount(identity, completion);
  const host = new RecoveryHost(challenge, completion, outcome);
  const coordinator = new DesktopPersonalAccountLinkCoordinator({
    account,
    host,
    manifest: {
      load: async () =>
        ({ deploymentId: runtime.discovery.deploymentId, name: "This computer" }) as never,
      save: async (_previous, next) => next,
    },
    runtime: { current: async () => runtime },
    store,
  });
  return { account, challenge, completion, coordinator, host, proof, runtime, store };
}

class DurableMemoryLinkStore {
  readonly snapshots: DesktopPersonalAccountLinkState[] = [];
  #state: DesktopPersonalAccountLinkState | null = null;

  async load(_deploymentId: string): Promise<DesktopPersonalAccountLinkState | null> {
    return this.#state ? structuredClone(this.#state) : null;
  }

  async save(
    _deploymentId: string,
    input: DesktopPersonalAccountLinkState,
  ): Promise<DesktopPersonalAccountLinkState> {
    const state = DesktopPersonalAccountLinkStateSchema.parse(structuredClone(input));
    this.#state = state;
    this.snapshots.push(structuredClone(state));
    return structuredClone(state);
  }

  async clear(): Promise<void> {
    this.#state = null;
  }

  async inspect(
    _deploymentId: string,
    _runtime: PersonalHostRuntimeRecord,
    accountLink: PersonalRemoteAccessStatus["accountLink"],
  ) {
    void accountLink;
    return { journal: this.#state ? structuredClone(this.#state) : null, status: "ready" as const };
  }

  async reconcileForMutation(
    _deploymentId: string,
    _runtime: PersonalHostRuntimeRecord,
    accountLink: PersonalRemoteAccessStatus["accountLink"],
  ) {
    void accountLink;
    return { journal: this.#state ? structuredClone(this.#state) : null, status: "ready" as const };
  }
}

class LostResponseAccount implements PersonalAccountLinkControlPlane {
  readonly accountOrigin = "https://accounts.opensteer.test";
  readonly completeCalls: Array<{
    readonly challengeId: PersonalHostAccountLinkChallengeId;
    readonly input: {
      readonly challengeCredential: PersonalHostAccountLinkChallengeCredential;
      readonly proof: PersonalHostAccountLinkProofEnvelope;
    };
  }> = [];
  readonly issueCalls: IssuePersonalHostAccountLinkChallengeRequest[] = [];
  loseFirstIssueResponse = false;
  readonly #challenge: IssuePersonalHostAccountLinkChallengeResponse;
  readonly #completion: CompletePersonalHostAccountLinkResponse;
  #issueResponseLost = false;

  constructor(
    challenge: IssuePersonalHostAccountLinkChallengeResponse,
    completion: CompletePersonalHostAccountLinkResponse,
  ) {
    this.#challenge = challenge;
    this.#completion = completion;
  }

  async accountIdentity() {
    return this.#challenge.account;
  }

  async issuePersonalHostAccountLinkChallenge(
    input: IssuePersonalHostAccountLinkChallengeRequest,
  ): Promise<IssuePersonalHostAccountLinkChallengeResponse> {
    this.issueCalls.push(structuredClone(input));
    if (this.loseFirstIssueResponse && !this.#issueResponseLost) {
      this.#issueResponseLost = true;
      throw new Error("Account issue response was lost");
    }
    return structuredClone(this.#challenge);
  }

  async completePersonalHostAccountLink(
    challengeId: PersonalHostAccountLinkChallengeId,
    input: {
      readonly challengeCredential: PersonalHostAccountLinkChallengeCredential;
      readonly proof: PersonalHostAccountLinkProofEnvelope;
    },
  ): Promise<CompletePersonalHostAccountLinkResponse> {
    this.completeCalls.push({ challengeId, input: structuredClone(input) });
    return structuredClone(this.#completion);
  }
}

class RecoveryAccount implements PersonalAccountLinkControlPlane {
  readonly accountOrigin = "https://accounts.opensteer.test";
  completeCalls = 0;
  identityCalls = 0;
  readonly #completion: CompletePersonalHostAccountLinkResponse;
  readonly #identity: IssuePersonalHostAccountLinkChallengeResponse["account"] | null;

  constructor(
    identity: IssuePersonalHostAccountLinkChallengeResponse["account"] | null,
    completion: CompletePersonalHostAccountLinkResponse,
  ) {
    this.#identity = identity;
    this.#completion = completion;
  }

  async accountIdentity() {
    this.identityCalls += 1;
    return this.#identity;
  }

  async completePersonalHostAccountLink(): Promise<CompletePersonalHostAccountLinkResponse> {
    this.completeCalls += 1;
    return structuredClone(this.#completion);
  }

  async issuePersonalHostAccountLinkChallenge(): Promise<IssuePersonalHostAccountLinkChallengeResponse> {
    throw new Error("A persisted completion must not issue another challenge.");
  }
}

class RecoveryHost {
  linkState: "activating" | "active" = "active";
  resumeCalls = 0;
  readonly consumeCalls: Array<{
    readonly completionGrant: PersonalHostAccountLinkCompletionGrant;
    readonly hostCredential: string;
    readonly linkGeneration: string;
  }> = [];
  readonly #account: IssuePersonalHostAccountLinkChallengeResponse["account"];
  readonly #completion: CompletePersonalHostAccountLinkResponse;
  readonly #outcome: "accept" | "reject-grant" | "reject-once" | "transient";
  #linked = false;

  constructor(
    challenge: IssuePersonalHostAccountLinkChallengeResponse,
    completion: CompletePersonalHostAccountLinkResponse,
    outcome: "accept" | "reject-grant" | "reject-once" | "transient",
  ) {
    this.#account = challenge.account;
    this.#completion = completion;
    this.#outcome = outcome;
  }

  async status(): Promise<PersonalRemoteAccessStatus> {
    return {
      accountLink:
        this.#linked || this.linkState === "activating"
          ? {
              ...this.#account,
              generation: this.#completion.linkGeneration,
              state: this.linkState,
            }
          : null,
      generation: 0,
      mode: "off",
      route: null,
      schemaVersion: 2,
    };
  }

  async approveAccountLink(): Promise<never> {
    throw new Error("A persisted proof must not be approved again.");
  }

  async resumeAccountLink(): Promise<PersonalRemoteAccessStatus> {
    this.resumeCalls += 1;
    this.linkState = "active";
    this.#linked = true;
    return this.status();
  }

  async consumeAccountLink(
    _runtime: PersonalHostRuntimeRecord,
    input: {
      readonly completionGrant: PersonalHostAccountLinkCompletionGrant;
      readonly hostCredential: string;
      readonly linkGeneration: string;
    },
  ): Promise<PersonalRemoteAccessStatus> {
    this.consumeCalls.push(structuredClone(input));
    if (this.#outcome === "transient") throw new Error("Host temporarily unavailable");
    if (
      this.#outcome === "reject-grant" ||
      (this.#outcome === "reject-once" && this.consumeCalls.length === 1)
    ) {
      throw new PersonalHostAccountLinkCompletionGrantRejectedError();
    }
    this.#linked = true;
    return this.status();
  }
}

class IdempotentLostResponseHost {
  readonly approveCalls: Array<{
    readonly challenge: IssuePersonalHostAccountLinkChallengeResponse;
    readonly runtime: PersonalHostRuntimeRecord;
  }> = [];
  readonly consumeCalls: Array<{
    readonly completionGrant: PersonalHostAccountLinkCompletionGrant;
    readonly hostCredential: string;
    readonly linkGeneration: string;
    readonly runtime: PersonalHostRuntimeRecord;
  }> = [];
  readonly #proof: PersonalHostAccountLinkProofEnvelope;
  readonly #account: IssuePersonalHostAccountLinkChallengeResponse["account"];
  readonly #linkGeneration = AccountLinkGenerationSchema.parse("g".repeat(43));
  readonly #consumed = new Set<PersonalHostAccountLinkCompletionGrant>();

  constructor(proof: PersonalHostAccountLinkProofEnvelope) {
    this.#proof = proof;
    this.#account = proof.document.account;
  }

  async status(): Promise<PersonalRemoteAccessStatus> {
    return {
      accountLink:
        this.#consumed.size > 0
          ? { ...this.#account, generation: this.#linkGeneration, state: "active" }
          : null,
      generation: 0,
      mode: "off",
      route: null,
      schemaVersion: 2,
    };
  }

  async approveAccountLink(
    runtime: PersonalHostRuntimeRecord,
    challenge: IssuePersonalHostAccountLinkChallengeResponse,
  ): Promise<PersonalHostAccountLinkProofEnvelope> {
    this.approveCalls.push({
      challenge: structuredClone(challenge),
      runtime: structuredClone(runtime),
    });
    return structuredClone(this.#proof);
  }

  async resumeAccountLink(): Promise<PersonalRemoteAccessStatus> {
    return this.status();
  }

  async consumeAccountLink(
    runtime: PersonalHostRuntimeRecord,
    input: {
      readonly completionGrant: PersonalHostAccountLinkCompletionGrant;
      readonly hostCredential: string;
      readonly linkGeneration: string;
    },
  ): Promise<PersonalRemoteAccessStatus> {
    this.consumeCalls.push({ ...input, runtime: structuredClone(runtime) });
    if (!this.#consumed.has(input.completionGrant)) {
      this.#consumed.add(input.completionGrant);
      throw new Error("Host consume response was lost");
    }
    return {
      accountLink: { ...this.#account, generation: this.#linkGeneration, state: "active" },
      generation: 0,
      mode: "off",
      route: null,
      schemaVersion: 2,
    };
  }
}

function personalRuntime(): PersonalHostRuntimeRecord {
  const discovery = {
    canonicalOrigin: "http://127.0.0.1:4310",
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" as const },
    deploymentShape: {
      defaultWorkspaceBacking: "local-directory" as const,
      kind: "personal" as const,
    },
  };
  return PersonalHostRuntimeRecordSchema.parse({
    discovery,
    discoveryEnvelope: {
      document: discovery,
      publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
      signature: "A".repeat(86),
    },
    localOrigin: "http://127.0.0.1:4310",
    observedAt: "2026-08-12T12:00:00.000Z",
    ownership: "desktop-personal-host-supervisor",
    schemaVersion: 2,
    state: "ready",
    verification: "signed-loopback-discovery",
  });
}

function accountLinkChallenge(
  runtime: PersonalHostRuntimeRecord,
): IssuePersonalHostAccountLinkChallengeResponse {
  return IssuePersonalHostAccountLinkChallengeResponseSchema.parse({
    account: {
      issuer: "https://accounts.opensteer.test",
      subject: `acct_${crypto.randomUUID()}`,
    },
    authorityEnvelope: runtime.discoveryEnvelope,
    challengeCredential: `olc_${"b".repeat(43)}`,
    challengeId: `phc_${crypto.randomUUID()}`,
    expiresAt: "2026-08-12T12:05:00.000Z",
  });
}

function accountLinkProof(
  challenge: IssuePersonalHostAccountLinkChallengeResponse,
): PersonalHostAccountLinkProofEnvelope {
  return PersonalHostAccountLinkProofEnvelopeSchema.parse({
    document: {
      account: challenge.account,
      authority: challenge.authorityEnvelope.document,
      challenge: {
        credentialSha256: "c".repeat(43),
        id: challenge.challengeId,
      },
      documentVersion: 2,
      expiresAt: "2026-08-12T12:04:00.000Z",
      issuedAt: "2026-08-12T12:00:00.000Z",
      purpose: "opensteer-personal-host-account-link",
    },
    publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
    signature: "A".repeat(86),
  });
}

function accountLinkCompletion(): CompletePersonalHostAccountLinkResponse {
  return CompletePersonalHostAccountLinkResponseSchema.parse({
    completionGrant: jwt("completion"),
    hostCredential: `osc_${"d".repeat(43)}`,
    linkGeneration: "g".repeat(43),
    resultExpiresAt: "2026-08-13T12:00:00.000Z",
  });
}

function testCryptography(): DesktopSecretCryptography {
  return {
    decryptStringAsync: async (encrypted) => ({
      result: encrypted.toString("utf8"),
      shouldReEncrypt: false,
    }),
    encryptStringAsync: async (plaintext) => Buffer.from(plaintext, "utf8"),
    getSelectedStorageBackend: () => "keychain",
    isAsyncEncryptionAvailable: async () => true,
  };
}

async function writeProtectedLinkState(
  dataDirectory: string,
  runtime: PersonalHostRuntimeRecord,
  cryptography: DesktopSecretCryptography,
  state: unknown,
): Promise<void> {
  const filePath = desktopPersonalAccountLinkSecretsPath(
    dataDirectory,
    runtime.discovery.deploymentId,
  );
  await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  const encrypted = await cryptography.encryptStringAsync(JSON.stringify(state));
  await writeFile(
    filePath,
    `${JSON.stringify({ ciphertext: encrypted.toString("base64"), schemaVersion: 1 })}\n`,
    { mode: 0o600 },
  );
}

function jwt(seed: string): string {
  return `${seed.repeat(4)}.${"e".repeat(32)}.${"f".repeat(32)}`;
}
