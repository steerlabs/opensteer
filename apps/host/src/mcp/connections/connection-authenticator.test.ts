import { createId } from "@opensteer/core";
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HostAuthenticator } from "../../identity/auth.js";
import { SignedTokenService } from "../../identity/host-keys.js";
import { RunCapabilityTokenService } from "../../agents/run-capability.js";
import { TriggerCapabilityTokenService } from "../../triggers/trigger-control-service.js";
import { WatchCapabilityTokenService } from "../../triggers/watch-capability.js";
import { RunnerAuthenticator } from "../../agents/runner-authenticator.js";
import { ConnectionAuthenticator } from "./connection-authenticator.js";
import { ConnectionOAuth, redirectMatches, mcpResourcePath } from "./connection-oauth.js";
import type { AgentConnectionStore } from "@opensteer/database";

const credential = `ost_mcp_${"c".repeat(43)}`;
const pair = generateKeyPairSync("ed25519");
const origin = "http://127.0.0.1:4310";

describe("MCP connection audience", () => {
  it("refuses all other credential families before accessing the connection store", async () => {
    const authenticate = vi.fn();
    const connections = new ConnectionAuthenticator({ authenticate });
    const tokens = new SignedTokenService(pair, {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    });
    for (const bearer of [
      "browser-cookie",
      "osp_" + "a".repeat(43),
      "PersonalRemote credential",
      tokens.issue({ aud: "opensteer-agent-control" }, 60),
      tokens.issue({ aud: "opensteer-trigger-control" }, 60),
      tokens.issue({ aud: "opensteer-watch-control" }, 60),
      tokens.issue({ aud: "native-oauth" }, 60),
      credential + "extra",
    ]) {
      await expect(connections.authenticate(bearer)).rejects.toMatchObject({
        code: "unauthorized",
      });
    }
    expect(authenticate).not.toHaveBeenCalled();
  });
  it("never converts an MCP credential to a native Host session or falls through to cookies", async () => {
    const native = vi.fn(),
      cookie = vi.fn();
    const host = new HostAuthenticator({
      publicUrl: new URL(origin),
      identity: {
        authenticateNativeAccessToken: native,
        requireSession: cookie,
        userSessionProfile: vi.fn(),
      },
    });
    await expect(
      host.authenticateSession({
        authorization: `Bearer ${credential}`,
        cookie: "valid-session=x",
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(native).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  });
  it("is rejected by Run, Trigger, Watch and Runner ticket authenticators", async () => {
    const tokens = new SignedTokenService(pair, {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    });
    const run = new RunCapabilityTokenService({
      audience: "opensteer-agent-control",
      tokens,
      authorizer: { assertActiveGrant: vi.fn() },
    });
    const trigger = new TriggerCapabilityTokenService({
      audience: "opensteer-trigger-control",
      tokens,
      store: { assertActiveExecutionBinding: vi.fn() },
    });
    const watch = new WatchCapabilityTokenService({
      audience: "opensteer-watch-control",
      tokens,
      store: { assertActiveWatchBinding: vi.fn() },
    });
    for (const authenticator of [run, trigger, watch])
      await expect(authenticator.authenticate(credential)).rejects.toMatchObject({
        code: "unauthorized",
      });
    const runner = new RunnerAuthenticator({
      issuancePrivateKey: pair.privateKey,
      store: {} as never,
    });
    expect(() => runner.verifyShellDataTicket(credential)).toThrow();
    expect(() => runner.verifyDisplayDataTicket(credential)).toThrow();
  });
  it("checks live authority on every call instead of retaining an authenticated session", async () => {
    const owner = createId("user");
    const record = {
      id: `mcn_${crypto.randomUUID()}`,
      userId: owner,
      label: "Agent",
      clientName: "Client",
      accessMode: "auto" as const,
      reach: { kind: "user" as const },
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const authenticate = vi.fn().mockResolvedValueOnce(record).mockResolvedValueOnce(null);
    const connections = new ConnectionAuthenticator({ authenticate });
    await expect(
      connections.authenticate(credential, origin + mcpResourcePath),
    ).resolves.toMatchObject({
      connectionId: record.id,
      userId: owner,
      accessMode: "auto",
      reach: { kind: "user" },
    });
    await expect(
      connections.authenticate(credential, origin + mcpResourcePath),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(authenticate).toHaveBeenCalledTimes(2);
  });
});

describe("stateless MCP registration", () => {
  const store = {} as AgentConnectionStore;
  function oauth() {
    return new ConnectionOAuth({
      deploymentId: createId("deployment"),
      store,
      signingKey: pair.privateKey,
      verificationKey: pair.publicKey,
    });
  }
  const challenge = createHash("sha256").update("x".repeat(64)).digest("base64url");
  it("survives a Host restart without a client registry and binds registration to its issuer", () => {
    const registered = oauth().register(origin, {
      client_name: "Example",
      redirect_uris: ["https://client.example/cb"],
    });
    const request = {
      client_id: registered.client_id,
      redirect_uri: "https://client.example/cb",
      response_type: "code",
      resource: origin + mcpResourcePath,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    expect(oauth().authorize(origin, request)).toMatch(/^\/mcp-authorization\?request=/);
    expect(() =>
      oauth().authorize("https://other.example", {
        ...request,
        resource: "https://other.example" + mcpResourcePath,
      }),
    ).toThrow("invalid_client");
    expect(() =>
      oauth().authorize(origin, { ...request, client_id: registered.client_id + "tampered" }),
    ).toThrow("invalid_client");
  });
  it("rejects unsafe redirects, missing resource, changed resource and weaker PKCE", () => {
    for (const uri of [
      "https://user:password@client.example/cb",
      "http://client.example/cb",
      "https://client.example/cb#",
      "javascript:alert(1)",
    ])
      expect(() => oauth().register(origin, { redirect_uris: [uri] })).toThrow();
    const client = oauth().register(origin, { redirect_uris: ["http://127.0.0.1/cb"] });
    const input = {
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:54001/cb",
      response_type: "code",
      resource: origin + mcpResourcePath,
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    expect(() => oauth().authorize(origin, { ...input, resource: undefined })).toThrow();
    expect(() =>
      oauth().authorize(origin, { ...input, resource: input.resource + "?other" }),
    ).toThrow("invalid_target");
    expect(() => oauth().authorize(origin, { ...input, code_challenge_method: "plain" })).toThrow();
    expect(() =>
      oauth().authorize(origin, { ...input, redirect_uri: "http://localhost:54001/cb" }),
    ).toThrow("invalid_redirect_uri");
  });
  it("allows only the loopback port exception and matches HTTPS exactly", () => {
    expect(redirectMatches("http://127.0.0.1/cb", "http://127.0.0.1:52000/cb")).toBe(true);
    expect(redirectMatches("https://client.example/cb", "https://client.example:444/cb")).toBe(
      false,
    );
    expect(redirectMatches("http://127.0.0.1/cb", "http://127.0.0.1:52000/cb?next=evil")).toBe(
      false,
    );
  });
});
