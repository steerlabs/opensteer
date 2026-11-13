import {
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  CompletePersonalHostAccountLinkResponseSchema,
} from "@opensteer/control-plane-protocol";
import { it, expect, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  PersonalRemoteAccessClient,
  removeHostSession,
  linkPersonalHostAccount,
} from "./personal-remote-access.js";
import { unwrapRpcResult } from "./host-session-client.js";
import { HostClientRequestError } from "./client.js";

it("shows persisted pending administration in the shared client and stops observation on disposal", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  const resource = new PersonalRemoteAccessClient(host);
  const stop = resource.start();
  try {
    await vi.waitFor(() => expect(resource.getSnapshot().status).not.toBeNull(), { timeout: 1000 });
    await resource.request({ action: "configure", mode: "off", privateOrigin: null });
    await vi.waitFor(
      () =>
        expect(resource.getSnapshot().status?.operation).toMatchObject({
          state: "pending",
          detail: "Waiting for the Opensteer desktop app to run on this computer.",
        }),
      { timeout: 1000 },
    );
    const own = unwrapRpcResult(await host.rpc["sessions.list"]({})).sessions.find(
      (session) => session.current,
    )!;
    await removeHostSession(host, own.id);
    expect(
      unwrapRpcResult(await host.rpc["sessions.list"]({})).sessions.map((session) => session.id),
    ).not.toContain(own.id);
  } finally {
    stop();
    host.dispose();
  }
});

it("keeps newer observed progress when an older command acknowledgement arrives later", async () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  const base = unwrapRpcResult(await mock.rpc["personal.remoteAccess.get"]({}));
  let status = base;
  let invalidate!: () => void;
  let acknowledge!: (result: import("@opensteer/protocol").HostApiCommandOutput) => void;
  const id = crypto.randomUUID();
  const operation = {
    id,
    executionId: id,
    intent: { action: "configure" as const, mode: "off" as const, privateOrigin: null },
    state: "pending" as const,
    detail: null,
  };
  const client = {
    rpc: { "personal.remoteAccess.get": async () => ({ ok: true, data: status }) },
    subscribePersonalRemoteAccess: (listener: () => void) => {
      invalidate = listener;
      return () => {};
    },
    dispatch: () =>
      new Promise<import("@opensteer/protocol").HostApiCommandOutput>((resolve) => {
        acknowledge = resolve;
      }),
  } as unknown as import("./client.js").HostClient;
  const resource = new PersonalRemoteAccessClient(client);
  const stop = resource.start();
  try {
    await vi.waitFor(() => expect(resource.getSnapshot().status).toEqual(base), { timeout: 1000 });
    const request = resource.request(operation.intent);
    status = {
      ...base,
      revision: base.revision + 2,
      operation: { ...operation, state: "succeeded" },
    };
    invalidate();
    await vi.waitFor(
      () => expect(resource.getSnapshot().status?.operation?.state).toBe("succeeded"),
      { timeout: 1000 },
    );
    acknowledge({ type: "personal.remoteAccess.request", operation });
    await request;
    expect(resource.getSnapshot().status?.operation?.state).toBe("succeeded");
  } finally {
    stop();
    mock.dispose();
  }
});

it("recovers a failed status read on Host reconnect without polling", async () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  const status = unwrapRpcResult(await mock.rpc["personal.remoteAccess.get"]({}));
  let invalidate: (() => void) | undefined;
  const detach = vi.fn();
  const read = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue({
    ok: true,
    data: status,
  });
  const client = {
    rpc: { "personal.remoteAccess.get": read },
    dispatch: vi.fn(),
    subscribePersonalRemoteAccess: (listener: () => void) => {
      invalidate = listener;
      return detach;
    },
  } as unknown as import("./client.js").HostClient;
  const resource = new PersonalRemoteAccessClient(client);
  const stop = resource.start();
  try {
    await vi.waitFor(() => expect(resource.getSnapshot().error).toBe("Connection lost"), {
      timeout: 1000,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(invalidate).toBeTypeOf("function");
    invalidate!();
    await vi.waitFor(() => expect(resource.getSnapshot().status).toEqual(status), {
      timeout: 1000,
    });
    expect(resource.getSnapshot().error).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.every(([input]) => JSON.stringify(input) === "{}")).toBe(true);
    stop();
    expect(detach).toHaveBeenCalledOnce();
    invalidate!();
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    mock.dispose();
  }
});

it("keeps a refused pairing apart from status reads, in the Host's words or a plain sentence", async () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  const status = unwrapRpcResult(await mock.rpc["personal.remoteAccess.get"]({}));
  const dispatch = vi
    .fn()
    .mockRejectedValueOnce(
      new HostClientRequestError({
        code: "conflict",
        message: "Turn on a private network first.",
        status: 409,
      }),
    )
    .mockRejectedValueOnce(new Error("ECONNRESET /Users/tim/secret"));
  const client = {
    rpc: { "personal.remoteAccess.get": async () => ({ ok: true, data: status }) },
    dispatch,
    subscribePersonalRemoteAccess: () => () => {},
  } as unknown as import("./client.js").HostClient;
  const resource = new PersonalRemoteAccessClient(client);
  const stop = resource.start();
  try {
    await vi.waitFor(() => expect(resource.getSnapshot().status).toEqual(status), {
      timeout: 1000,
    });
    await resource.pair();
    expect(resource.getSnapshot()).toMatchObject({
      actionError: "Turn on a private network first.",
      error: null,
      status,
    });
    await resource.pair();
    expect(resource.getSnapshot().actionError).toBe("Something went wrong. Try again.");
  } finally {
    stop();
    mock.dispose();
  }
});

it("forwards only the sealed Account completion from the signing device to the Host", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    const status = unwrapRpcResult(await host.rpc["personal.remoteAccess.get"]({}));
    const now = new Date();
    const challenge = IssuePersonalHostAccountLinkChallengeResponseSchema.parse({
      completionFormat: "sealed-v1",
      account: {
        issuer: "https://accounts.opensteer.test",
        subject: `acct_${crypto.randomUUID()}`,
      },
      authorityEnvelope: status.authorityEnvelope,
      challengeId: `phc_${crypto.randomUUID()}`,
      challengeCredential: `olc_${"c".repeat(43)}`,
      expiresAt: new Date(now.getTime() + 120000).toISOString(),
    });
    const proof = PersonalHostAccountLinkProofEnvelopeSchema.parse({
      document: {
        account: challenge.account,
        authority: status.authorityEnvelope.document,
        challenge: { id: challenge.challengeId, credentialSha256: "c".repeat(43) },
        documentVersion: 3,
        completionPublicKey: "k".repeat(43),
        issuedAt: now.toISOString(),
        expiresAt: challenge.expiresAt,
        purpose: "opensteer-personal-host-account-link",
      },
      publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
      signature: "A".repeat(86),
    });
    const completion = CompletePersonalHostAccountLinkResponseSchema.parse({
      challengeId: challenge.challengeId,
      schemaVersion: 2,
      linkGeneration: "g".repeat(43),
      resultExpiresAt: challenge.expiresAt,
      sealedCompletion: {
        version: 1,
        ciphertext: "abc",
        ephemeralPublicKey: "k".repeat(43),
        nonce: "n".repeat(16),
        tag: "t".repeat(22),
      },
    });
    const dispatch = vi
      .fn<import("./client.js").HostClient["dispatch"]>()
      .mockResolvedValueOnce({ type: "personal.accountLink.approve", proof })
      .mockResolvedValueOnce({ type: "personal.accountLink.complete", access: status.access });
    const account = {
      issuePersonalHostAccountLinkChallenge: vi.fn(async () => challenge),
      completePersonalHostAccountLink: vi.fn(async () => completion),
    };
    await linkPersonalHostAccount({ dispatch }, account, status.authorityEnvelope, "My computer");
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "personal.accountLink.complete",
      completion,
      idempotencyKey: expect.any(String),
    });
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("osc_");
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("completionGrant");
    expect(account.completePersonalHostAccountLink).toHaveBeenCalledWith(challenge.challengeId, {
      challengeCredential: challenge.challengeCredential,
      proof,
    });
  } finally {
    host.dispose();
  }
});
