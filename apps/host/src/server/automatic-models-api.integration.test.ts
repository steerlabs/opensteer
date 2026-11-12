import { automaticModelsCapability, AutomaticModelsViewSchema } from "@opensteer/protocol";
import { createId, emptyAutomaticModelConfig, type AutomaticModelConfig } from "@opensteer/core";
import { expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { HostAuthenticator } from "../identity/auth.js";
import { signHostDiscovery } from "../identity/host-keys.js";
import { advertisedCapabilities, createHostServer } from "../server.js";
import { hostServerTestDependencies } from "./host-server-test-harness.js";
import { injectRpcRequest } from "./test-host-api-request.js";

// The preview itself belongs to the Host's automatic-model sites; this file
// proves only who it is built for and how the API reaches it.
const preview = vi.hoisted(() => vi.fn());
vi.mock("../agents/automatic-models.js", () => ({ readAutomaticModelPreview: preview }));

it("serves and replaces automatic models for the signed-in person only, behind its capability", async ({
  onTestFinished,
}) => {
  const owner = await (
    await import("../runtime/personal-owner.test-support.js")
  ).createPersonalOwnerFixture();
  onTestFinished(() => owner.close());
  const userId = owner.ownerId;
  const session = {
    absoluteExpiresAt: "2026-12-12T00:00:00.000Z",
    createdAt: "2026-11-04T00:00:00.000Z",
    expiresAt: "2026-11-05T00:00:00.000Z",
    id: createId("authSession"),
    user: {
      disabledAt: null,
      displayName: "Person",
      email: "person@example.com",
      emailVerified: true,
      id: userId,
      image: null,
    },
  };
  const authenticator = new HostAuthenticator({
    identity: {
      nativeOpenIdConfiguration: () => undefined,
      authenticateNativeAccessToken: async () => ({
        absoluteExpiresAt: new Date(session.absoluteExpiresAt),
        application: "mobile",
        clientId: "opensteer-mobile",
        createdAt: new Date(session.createdAt),
        expiresAt: new Date(session.expiresAt),
        sessionId: session.id,
        subject: userId,
      }),
      requireSession: async () => session,
      userSessionProfile: async () => session.user,
    } as never,
    publicUrl: new URL("https://opensteer.example"),
  });
  // A client gates both calls on this name; an older Host never advertises it.
  expect(advertisedCapabilities({ attachments: {} as never, authenticator })).toContain(
    automaticModelsCapability,
  );
  const view = AutomaticModelsViewSchema.parse({
    config: emptyAutomaticModelConfig,
    maintainedDefaults: { light: [], deep: [] },
    accounts: [],
    light: { label: "General preference", candidates: [], skipped: [] },
    deep: { candidates: [], skipped: [] },
  });
  preview.mockResolvedValue(view);
  const setAutomaticModelConfig = vi.fn(
    async (_userId: string, config: AutomaticModelConfig) => config,
  );
  const app = await createHostServer(
    hostServerTestDependencies({
      authenticator,
      discovery: signHostDiscovery(generateKeyPairSync("ed25519"), {
        canonicalOrigin: "https://opensteer.example",
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        hostKey: { algorithm: "Ed25519" },
        deploymentShape: { kind: "personal" },
      }),
      store: { database: owner.database, setAutomaticModelConfig } as never,
    }),
  );
  try {
    const headers = { authorization: "Bearer native-phone" };
    const read = await injectRpcRequest(app, "automaticModels.get", {}, headers);
    expect(read.json()).toEqual({ ok: true, data: view });
    expect(preview).toHaveBeenCalledWith(expect.anything(), userId);

    const config = { roles: {}, excludedAccounts: [createId("harnessInstance")] };
    const command = { type: "automaticModels.set", idempotencyKey: "automatic-set", config };
    const set = await injectRpcRequest(app, "commands.dispatch", command, headers);
    expect(set.json()).toEqual({ ok: true, data: { type: "automaticModels.set", config } });
    expect(setAutomaticModelConfig).toHaveBeenCalledWith(userId, config);
    // Whose config it is comes from the session alone.
    const spoof = await injectRpcRequest(
      app,
      "commands.dispatch",
      { ...command, userId: createId("user") },
      headers,
    );
    expect(spoof.statusCode).toBe(400);
    expect(setAutomaticModelConfig).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
