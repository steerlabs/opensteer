import { IntegrationAuthorizationAttemptIdSchema } from "@opensteer/integration-core";
import type { HostApiCommand } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { HostClientRequestError } from "../host/client.js";
import {
  PluginSignInDismissed,
  PluginSignInFlow,
  pluginSignInChoices,
  returnPluginAuthorization,
  type PluginOAuthMethods,
  type PluginOAuthStatus,
  type PluginSignInLaunch,
  type PluginSignInState,
} from "./sign-in.js";

const attemptId = IntegrationAuthorizationAttemptIdSchema.parse(
  "ioa_00000000-0000-4000-8000-000000000001",
);
const consent = { digest: "a".repeat(64), sites: ["https://api.linear.app"], credential: "sealed" };
const review = "R".repeat(43);
const target = { pluginId: "plg_linear", requirement: "linear", scope: "app" } as const;
const expiresAt = new Date(Date.now() + 600_000).toISOString();

function prepared(overrides: Partial<PluginOAuthMethods> = {}): PluginOAuthMethods {
  return {
    connection: "con_1",
    consent: consent as PluginOAuthMethods["consent"],
    redirectUri: "https://accounts.example/v1/oauth-broker/callback/plugin",
    methods: [
      {
        method: "oauth",
        oneClick: true,
        review,
        setup: {
          kind: "oauth2",
          grant: "authorization_code",
          mode: "automatic",
          scopes: ["read", "write"],
          firstParty: { label: "Opensteer" },
          tokenEndpointAuthMethod: "client_secret_post",
          clients: [{ id: "oac_1", clientId: "my-app", source: "manual", hasSecret: true }],
        },
      },
      { method: "key", oneClick: false, review: "K".repeat(43), setup: { kind: "secrets" } },
    ],
    ...overrides,
  };
}
const status = (value: PluginOAuthStatus["status"], extra: Partial<PluginOAuthStatus> = {}) => ({
  attemptId,
  connection: "con_1",
  account: value === "completed" ? "acc_1" : null,
  expiresAt,
  status: value,
  failureCode: null,
  ...extra,
});

/** A Host that answers each command as scripted and each status read from a queue. */
function host(script: {
  begin?: () => unknown;
  reads?: PluginOAuthStatus["status"][];
  read?: Partial<PluginOAuthStatus>;
  cancel?: PluginOAuthStatus["status"];
  returned?: PluginOAuthStatus["status"];
}) {
  const sent: HostApiCommand[] = [];
  const reads = [...(script.reads ?? ["launched"])];
  const dispatch = vi.fn(async (command: HostApiCommand) => {
    sent.push(command);
    switch (command.type) {
      case "plugin.authorization.prepare":
        return { type: command.type, ...prepared() };
      case "plugin.authorization.begin":
        if (script.begin) return script.begin();
        return {
          type: command.type,
          attemptId,
          connection: "con_1",
          expiresAt,
          launchTicket: "t".repeat(43),
        };
      case "plugin.authorization.return":
        return { type: command.type, ...status(script.returned ?? "completed") };
      case "plugin.authorization.cancel":
        return { type: command.type, ...status(script.cancel ?? "cancelled") };
      default:
        throw new Error(`unexpected ${command.type}`);
    }
  });
  const get = vi.fn(async () => {
    const next = reads.length > 1 ? reads.shift()! : reads[0]!;
    return { ok: true as const, data: status(next, script.read) };
  });
  return {
    client: { dispatch, rpc: { "plugin.authorization.get": get } } as never,
    sent,
    get,
  };
}

function surface(launch: Partial<PluginSignInLaunch> = {}) {
  const opened: PluginSignInLaunch = {
    route: vi.fn(async () => ({ returnPath: "/plugin-authorization", finish: "app" as const })),
    launch: vi.fn(async () => {}),
    abandon: vi.fn(),
    ...launch,
  };
  return { surface: { surface: "desktop" as const, open: vi.fn(() => opened) }, opened };
}

async function choosing(flow: PluginSignInFlow) {
  await flow.prepare();
  const state = flow.getState();
  if (state.step !== "choosing") throw new Error(`prepare ended at ${state.step}`);
  return state.choices;
}
async function ended(flow: PluginSignInFlow) {
  await vi.waitFor(() => expect(flow.getState().step).toBe("ended"), { timeout: 2_000 });
  return (flow.getState() as Extract<PluginSignInState, { step: "ended" }>).end;
}
const flowOf = (client: never, sign: ReturnType<typeof surface>) =>
  new PluginSignInFlow({
    client,
    surface: sign.surface,
    target,
    providerName: "Linear",
    pollIntervalMilliseconds: 1,
  });

describe("plugin sign-in choices", () => {
  it("offers one-click, saved apps and automatic setup, and an own app with its exact address", () => {
    const choices = pluginSignInChoices(prepared(), "Linear");
    expect(choices.options.map(({ kind, client }) => [kind, client])).toEqual([
      ["one-click", null],
      ["saved-app", { id: "oac_1" }],
      ["automatic", { automatic: true }],
    ]);
    expect(choices.ownApp).toEqual({
      method: "oauth",
      review,
      scopes: ["read", "write"],
      redirectUri: "https://accounts.example/v1/oauth-broker/callback/plugin",
      secret: "required",
    });
  });
});

describe("a plugin sign-in", () => {
  it("begins with the prepared consent and the method's review unchanged, then completes", async () => {
    const fake = host({ reads: ["launched", "completed"] });
    const sign = surface();
    const flow = flowOf(fake.client, sign);
    const choices = await choosing(flow);
    flow.start({ option: choices.options[0]! });
    expect(sign.surface.open).toHaveBeenCalledOnce();
    expect(await ended(flow)).toEqual({ kind: "completed", account: "acc_1" });
    const begin = fake.sent.find((command) => command.type === "plugin.authorization.begin");
    expect(begin).toMatchObject({
      input: {
        connection: "con_1",
        consent,
        method: "oauth",
        review,
        surface: "desktop",
        returnPath: "/plugin-authorization",
        finish: "app",
      },
    });
    expect(begin && "input" in begin && "client" in begin.input).toBe(false);
    expect(sign.opened.launch).toHaveBeenCalledWith(expect.objectContaining({ attemptId }));
  });

  it("sends an own app's id, secret and remember choice as the client", async () => {
    const fake = host({ reads: ["completed"] });
    const flow = flowOf(fake.client, surface());
    await choosing(flow);
    flow.start({ ownApp: { clientId: " my-client ", clientSecret: "s3cret", save: true } });
    await ended(flow);
    expect(fake.sent.find(({ type }) => type === "plugin.authorization.begin")).toMatchObject({
      input: { client: { clientId: "my-client", clientSecret: "s3cret", save: true } },
    });
  });

  it.each([
    ["denied", { kind: "denied" }],
    ["expired", { kind: "expired" }],
    [
      "failed",
      {
        kind: "failed",
        message:
          "The service didn't grant every permission the plugin needs. Sign in again and approve them all.",
      },
    ],
  ] as const)("ends %s as the Host recorded it", async (value, end) => {
    const fake = host({ reads: [value], read: { failureCode: "scope-escalation" } });
    const flow = flowOf(fake.client, surface());
    flow.start({ option: (await choosing(flow)).options[0]! });
    expect(await ended(flow)).toMatchObject(end);
  });

  it("says when the Host must be linked to an Account first, and opens nothing", async () => {
    const fake = host({
      begin: () => {
        throw new HostClientRequestError({
          code: "conflict",
          message: "Link this Host to Opensteer Account before starting sign-in remotely",
          reason: "plugin-account-link-required",
          status: 409,
        });
      },
    });
    const sign = surface();
    const flow = flowOf(fake.client, sign);
    flow.start({ option: (await choosing(flow)).options[0]! });
    expect(await ended(flow)).toMatchObject({ kind: "account-link-required" });
    expect(sign.opened.abandon).toHaveBeenCalledOnce();
    expect(sign.opened.launch).not.toHaveBeenCalled();
  });

  it("asks for a fresh review when consent or review changed between prepare and begin", async () => {
    const fake = host({
      begin: () => {
        throw new HostClientRequestError({
          code: "conflict",
          message: "Sign-in scopes or client configuration changed. Review them again.",
          reason: "plugin-consent-changed",
          status: 409,
        });
      },
    });
    const flow = flowOf(fake.client, surface());
    flow.start({ option: (await choosing(flow)).options[2]! });
    expect(await ended(flow)).toMatchObject({ kind: "review-changed" });
    // Trying again prepares a new connection rather than reusing the spent one.
    await flow.prepare();
    expect(fake.sent.filter(({ type }) => type === "plugin.authorization.prepare")).toHaveLength(2);
  });

  it("finishes from an app return routed to the plugin command, without another read", async () => {
    const fake = host({ reads: ["launched"] });
    const flow = flowOf(fake.client, surface());
    flow.start({ option: (await choosing(flow)).options[0]! });
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalled());
    const reads = fake.get.mock.calls.length;
    const returned = await returnPluginAuthorization(fake.client, attemptId, "P".repeat(43));
    expect(returned.status).toBe("completed");
    expect(fake.sent.at(-1)).toEqual({
      type: "plugin.authorization.return",
      idempotencyKey: `plugin-auth-return:${attemptId}`,
      attemptId,
      returnProof: "P".repeat(43),
    });
    expect(await ended(flow)).toEqual({ kind: "completed", account: "acc_1" });
    expect(fake.get.mock.calls.length).toBeLessThanOrEqual(reads + 1);
  });

  it("cancels only when asked; closing stops watching and leaves the sign-in open", async () => {
    const fake = host({ reads: ["launched"] });
    const flow = flowOf(fake.client, surface());
    flow.start({ option: (await choosing(flow)).options[0]! });
    await vi.waitFor(() => expect(flow.getState().step).toBe("waiting"));
    await flow.cancel();
    expect(flow.getState()).toMatchObject({ step: "ended", end: { kind: "cancelled" } });

    const other = host({ reads: ["launched"] });
    const closing = flowOf(other.client, surface());
    closing.start({ option: (await choosing(closing)).options[0]! });
    await vi.waitFor(() => expect(closing.getState().step).toBe("waiting"));
    closing.close();
    expect(other.sent.some(({ type }) => type === "plugin.authorization.cancel")).toBe(false);
  });

  it("reports a sign-in that finished before its cancel landed as finished", async () => {
    const fake = host({ reads: ["launched"], cancel: "completed" });
    const flow = flowOf(fake.client, surface());
    flow.start({ option: (await choosing(flow)).options[0]! });
    await vi.waitFor(() => expect(flow.getState().step).toBe("waiting"));
    await flow.cancel();
    expect(flow.getState()).toMatchObject({ end: { kind: "completed", account: "acc_1" } });
  });

  it("ends the sign-in when the person closes the system sheet", async () => {
    const fake = host({ reads: ["launched"] });
    const flow = flowOf(
      fake.client,
      surface({ launch: vi.fn(async () => Promise.reject(new PluginSignInDismissed())) }),
    );
    flow.start({ option: (await choosing(flow)).options[0]! });
    expect(await ended(flow)).toMatchObject({ kind: "cancelled" });
    expect(fake.sent.at(-1)).toMatchObject({ type: "plugin.authorization.cancel", attemptId });
  });
});
