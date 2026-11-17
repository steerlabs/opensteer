import { z } from "zod";
import Fastify from "fastify";
import { createId, OpensteerError, type AuthenticatedSession, type UserId } from "@opensteer/core";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiServerContext,
  type PluginCommand,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { HostAuthenticator } from "../identity/auth.js";
import { registerHostApi } from "../server/host-api-registration.js";
import { injectRpcRequest } from "../server/test-host-api-request.js";
import { PluginOwnerApi, isPluginCommand } from "./plugin-owner-api.js";
import { PluginServiceError } from "./engine-protocol.js";

const ownerId = createId("user");
const strangerId = createId("user");
const owner = { caller: "personal", mode: "automatic" };
const consent = {
  digest: "c".repeat(64),
  sites: ["https://api.linear.app"],
  credential: "sealed" as const,
};

function session(userId: UserId): AuthenticatedSession {
  return {
    id: createId("authSession"),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: {
      id: userId,
      displayName: "Person",
      email: "person@example.test",
      emailVerified: true,
      disabledAt: null,
      image: null,
    },
  };
}
const context = (userId: UserId) =>
  ({ session: session(userId) }) as unknown as HostApiServerContext;

function plugin(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Plugin ${id}`,
    slug: id,
    activeVersion: `${id}-v2`,
    requirements: {
      accounts: {
        linear: {
          scope: "app",
          provider: "linear",
          cardinality: "one",
          definition: {
            name: "Linear",
            auth: {
              key: {
                type: "secrets",
                label: "API key",
                fields: {
                  properties: {
                    token: { type: "string", title: "Token" },
                    region: { type: "string" },
                  },
                  required: ["token"],
                },
                plain: ["region"],
              },
              oauth: { type: "oauth2" },
            },
          },
        },
      },
    },
    ...overrides,
  };
}

function setup(
  options: { plugins?: number; tools?: number; local?: number; engineDown?: boolean } = {},
) {
  const settings = new Map<
    string,
    {
      pluginId: string;
      access: "all" | "read-only" | "off";
      author: "catalog" | "agent";
      versionAuthors: Record<string, "catalog" | "agent">;
    }
  >();
  const service = {
    state: vi.fn(() => ({ status: "ready" as const, generation: 1 })),
    installed: vi.fn(async () => {
      if (options.engineDown) throw new PluginServiceError("unavailable", "Engine stopped");
      return Array.from({ length: options.plugins ?? 3 }, (_, index) => ({
        plugin: plugin(
          `p${index}`,
          index === 1
            ? { activeVersion: null }
            : index === 2
              ? { requirements: { accounts: {} } }
              : {},
        ),
        links: [],
      }));
    }),
    detail: vi.fn(async ({ plugin: id }: { plugin: string }) => ({
      plugin: plugin(id),
      links: [
        {
          requirement: "linear",
          scope: "app",
          account: "acc1",
          consent: { ...consent, digest: "d".repeat(64) },
        },
      ],
      tools: {
        version: "v",
        items: Array.from({ length: options.tools ?? 2 }, (_, index) => ({
          name: `tool_${index}`,
          readOnly: index % 2 === 0,
        })),
      },
      skills: {
        revision: "a".repeat(64),
        app: { id, name: `Plugin ${id}`, slug: id },
        version: `${id}-v2`,
        skills: [{ name: "triage", description: "How to triage" }],
      },
      versions: [
        { id: `${id}-v1`, createdAt: "2026-11-01T00:00:00.000Z" },
        { id: `${id}-v2`, createdAt: "2026-11-02T00:00:00.000Z" },
      ],
      schedules: [],
      webhooks: [],
      workflows: [],
      hasPage: true,
    })),
    catalogList: vi.fn(async () => ({
      items: [
        {
          id: "linear",
          package: "@x/linear",
          name: "Linear",
          description: "d",
          icons: [],
          auth: [{ method: "key", kind: "secrets" }],
        },
      ],
      cursor: "next-page",
      feed: {},
    })),
    catalogDetail: vi.fn(),
    install: vi.fn(async (_input: unknown, _context: unknown) => ({
      status: "installed" as const,
      plugin: plugin("new"),
      version: { id: "new-v1" },
    })),
    activate: vi.fn(async () => null),
    remove: vi.fn(async () => null),
    accounts: vi.fn(async () => [{ id: "acc1", provider: "linear", label: "Work" }]),
    createApiKeyAccount: vi.fn(async () => ({ id: "acc2", provider: "linear", label: "New" })),
    removeAccount: vi.fn(async () => null),
    reviewAccountLink: vi.fn(async () => consent),
    linkAccount: vi.fn(async () => consent),
    unlinkAccount: vi.fn(async () => null),
    manage: vi.fn(async (input: unknown, _context: unknown) => {
      const { operation } = z.object({ operation: z.string() }).parse(input);
      return operation === "schedules.answer"
        ? {
            id: "r1",
            scheduleId: "schedule1",
            app: "p0",
            owner: "personal",
            name: "w",
            status: "denied",
            scheduledAt: "2026-11-01T00:00:00.000Z",
            startedAt: "2026-11-01T00:00:00.000Z",
            finishedAt: "2026-11-01T00:00:00.000Z",
            expiresAt: null,
            requestId: null,
            failure: null,
          }
        : {
            id: "run1",
            app: "p0",
            version: "p0-v2",
            workflow: "w",
            status: "queued",
            createdAt: "2026-11-01T00:00:00.000Z",
          };
    }),
  };
  const store = {
    settings: vi.fn(async () => [...settings.values()]),
    setAccess: vi.fn(
      async (_owner: UserId, pluginId: string, access: "all" | "read-only" | "off") => {
        settings.set(pluginId, {
          pluginId,
          author: "agent",
          versionAuthors: {},
          ...settings.get(pluginId),
          access,
        });
      },
    ),
    recordInstall: vi.fn(
      async (_owner: UserId, pluginId: string, version: string, author: "catalog" | "agent") => {
        const row = settings.get(pluginId);
        settings.set(pluginId, {
          pluginId,
          access: row?.access ?? "all",
          author,
          versionAuthors: { ...row?.versionAuthors, [version]: author },
        });
      },
    ),
    recordActivation: vi.fn(async () => {}),
  };
  const accountLinked = vi.fn(async () => {});
  const changed = vi.fn();
  const api = new PluginOwnerApi({
    service: service as never,
    settings: store as never,
    accountLinked,
    assertOwner: async (userId) => {
      if (userId !== ownerId)
        throw new OpensteerError({ code: "forbidden", message: "Owner only" });
    },
    localTools: async () =>
      Array.from({ length: options.local ?? 1 }, (_, index) => ({
        id: `app_device_con${index}`,
        kind: "device-app" as const,
        name: `calendar-mac-${String(index).padStart(3, "0")}`,
        title: "Calendar on Mac",
        computer: { id: "run_1", name: "Mac" },
        unavailable: index === 0 ? null : "Mac is offline.",
        tools: Array.from({ length: 600 }, (_, tool) => ({
          name: `tool_${tool}`,
          readOnly: tool % 2 === 0,
        })),
      })),
    changed,
  });
  return { api, service, store, settings, accountLinked, changed };
}

type Unkeyed = PluginCommand extends infer C
  ? C extends PluginCommand
    ? Omit<C, "idempotencyKey">
    : never
  : never;
const run = (api: PluginOwnerApi, command: Unkeyed, key: string = crypto.randomUUID()) =>
  api.command({ ...command, idempotencyKey: key } as PluginCommand, context(ownerId));

describe("the person's plugin API", () => {
  it("refuses anyone but the personal owner before reaching the engine", async () => {
    const { api, service } = setup();
    await expect(api.reads()["plugins.installed.list"]({}, context(strangerId))).rejects.toThrow(
      "Owner only",
    );
    await expect(
      api.command(
        { type: "plugins.remove", idempotencyKey: "k", pluginId: "p0" },
        context(strangerId),
      ),
    ).rejects.toThrow("Owner only");
    expect(service.installed).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("refuses a caller context a client tries to supply", async () => {
    const { api, service } = setup();
    const authenticator = new HostAuthenticator({
      identity: {
        requireSession: async () => session(ownerId),
        userSessionProfile: async () => session(ownerId).user,
        authenticateNativeAccessToken: async () => {
          const value = session(ownerId);
          return {
            sessionId: value.id,
            subject: value.user.id,
            createdAt: new Date(value.createdAt),
            expiresAt: new Date(value.expiresAt),
            absoluteExpiresAt: new Date(value.absoluteExpiresAt),
          };
        },
      } as never,
      publicUrl: new URL("http://127.0.0.1:4310"),
    });
    const app = Fastify();
    registerHostApi(app, authenticator, {
      ...api.reads(),
      "commands.dispatch": async (command: HostApiCommand, ctx: HostApiServerContext) =>
        rpcSuccess(isPluginCommand(command) ? await api.command(command, ctx) : { type: "x" }),
    } as never);
    const headers = { authorization: "Bearer native" };
    try {
      const smuggled = [
        injectRpcRequest(
          app,
          "plugins.get",
          { pluginId: "p0", caller: "agent:x", mode: "ask" },
          headers,
        ),
        injectRpcRequest(
          app,
          "commands.dispatch",
          { type: "plugins.remove", idempotencyKey: "k", pluginId: "p0", context: owner },
          headers,
        ),
      ];
      for (const response of await Promise.all(smuggled)) expect(response.statusCode).toBe(400);
      expect(service.detail).not.toHaveBeenCalled();
      expect(service.remove).not.toHaveBeenCalled();
      const allowed = await injectRpcRequest(app, "plugins.get", { pluginId: "p0" }, headers);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(service.detail).toHaveBeenCalledWith({ plugin: "p0" }, owner, undefined);
    } finally {
      await app.close();
    }
  });

  it("bounds the installed list and derives each plugin's state from the Host's records", async () => {
    const { api } = setup({ plugins: 250 });
    const result = await api.reads()["plugins.installed.list"]({}, context(ownerId));
    if (!result.ok) throw new Error("refused");
    const view = hostApi["plugins.installed.list"].success.parse(result.data);
    expect(view.plugins).toHaveLength(200);
    expect(view.engine).toEqual({ status: "ready" });
    const byId = new Map(view.plugins!.map((entry) => [entry.id, entry]));
    expect(byId.get("p0")).toMatchObject({
      status: "needs-account",
      accounts: { required: 1, linked: 0 },
    });
    expect(byId.get("p1")).toMatchObject({ status: "not-built" });
    expect(byId.get("p2")).toMatchObject({ status: "ready", access: "all", author: "agent" });
  });

  it("lists bounded local tools with their access, even while the engine is down", async () => {
    const { api } = setup({ engineDown: true, local: 120 });
    await run(api, { type: "plugins.access.set", pluginId: "app_device_con0", access: "off" });
    const result = await api.reads()["plugins.installed.list"]({}, context(ownerId));
    if (!result.ok) throw new Error("refused");
    const view = hostApi["plugins.installed.list"].success.parse(result.data);
    expect(view.plugins).toBeNull();
    expect(view.local).toHaveLength(100);
    expect(view.local[0]).toMatchObject({
      id: "app_device_con0",
      access: "off",
      unavailable: null,
    });
    expect(view.local[0]!.tools).toHaveLength(500);
    expect(view.local[1]).toMatchObject({ access: "all", unavailable: "Mac is offline." });
    await expect(api.reads()["plugins.installed.list"]({}, context(strangerId))).rejects.toThrow(
      "Owner only",
    );
  });

  it("bounds plugin detail and marks a link reviewed against an older declaration", async () => {
    const { api } = setup({ tools: 600 });
    const result = await api.reads()["plugins.get"]({ pluginId: "p0" }, context(ownerId));
    if (!result.ok) throw new Error("refused");
    const view = result.data;
    expect(view.tools).toHaveLength(500);
    expect(view.toolCount).toBe(600);
    expect(view.versions.map(({ id, active }) => [id, active])).toEqual([
      ["p0-v2", true],
      ["p0-v1", false],
    ]);
    expect(view.requirements[0]).toMatchObject({
      providerName: "Linear",
      consent,
      links: [{ account: { id: "acc1", label: "Work" }, current: false }],
    });
    expect(view.page).toEqual({
      url: null,
      reference: { kind: "plugin", pluginId: "p0" },
      unavailable: expect.any(String),
    });
  });

  it("pages the catalog through the engine with the Host's cursor", async () => {
    const { api, service } = setup();
    const result = await api
      .reads()
      ["plugins.catalog.list"]({ search: " lin ", cursor: "abc", limit: 20 }, context(ownerId));
    expect(service.catalogList).toHaveBeenCalledWith(
      { search: "lin", cursor: "abc", limit: 20 },
      owner,
    );
    expect(result.ok && result.data).toEqual({
      items: [
        {
          id: "linear",
          name: "Linear",
          description: "d",
          category: null,
          icon: null,
          auth: [{ method: "key", kind: "secrets", label: "API key" }],
        },
      ],
      cursor: "next-page",
    });
  });

  it("offers the API-key methods it can draw, with their fields, and says a sign-in exists", async () => {
    const { api } = setup();
    const result = await api
      .reads()
      ["plugins.account.review"](
        { pluginId: "p0", requirement: "linear", scope: "app" },
        context(ownerId),
      );
    expect(result.ok && result.data.methods).toEqual([
      {
        method: "key",
        label: "API key",
        fields: [
          {
            name: "token",
            title: "Token",
            description: null,
            type: "string",
            choices: null,
            required: true,
            plain: false,
          },
          {
            name: "region",
            title: "region",
            description: null,
            type: "string",
            choices: null,
            required: false,
            plain: true,
          },
        ],
      },
    ]);
    expect(result.ok && result.data.signIn).toBe(true);
    expect(result.ok && result.data.accounts).toEqual([
      { id: "acc1", provider: "linear", label: "Work" },
    ]);
  });

  it("records provenance for what it installs and activates", async () => {
    const { api, service, store, changed } = setup();
    await run(api, { type: "plugins.install", source: { kind: "catalog", catalogId: "linear" } });
    await run(api, {
      type: "plugins.install",
      source: { kind: "openapi", url: "https://api.example.com/openapi.json", name: "Example" },
    });
    expect(service.install.mock.calls.map(([input, context]) => [input, context])).toEqual([
      [{ kind: "catalog", id: "linear" }, owner],
      [{ kind: "openapi", url: "https://api.example.com/openapi.json", name: "Example" }, owner],
    ]);
    expect(store.recordInstall.mock.calls.map((call) => call.slice(1))).toEqual([
      ["new", "new-v1", "catalog"],
      ["new", "new-v1", "agent"],
    ]);
    await run(api, { type: "plugins.version.activate", pluginId: "p0", versionId: "p0-v1" });
    expect(service.activate).toHaveBeenCalledWith({ plugin: "p0", version: "p0-v1" }, owner);
    expect(store.recordActivation).toHaveBeenCalledWith(ownerId, "p0", "p0-v1");
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("answers a retried command with the first attempt instead of repeating it", async () => {
    const { api, service } = setup();
    const command = {
      type: "plugins.install",
      source: { kind: "catalog", catalogId: "linear" },
    } as const;
    const [first, second] = await Promise.all([
      run(api, command, "same"),
      run(api, command, "same"),
    ]);
    expect(second).toEqual(first);
    expect(service.install).toHaveBeenCalledTimes(1);
  });

  it("fulfils waiting Requests only after a person-reviewed link commits", async () => {
    const { api, service, accountLinked } = setup();
    const target = { pluginId: "p0", requirement: "linear", scope: "app" as const };
    await run(api, { type: "plugins.account.link", ...target, accountId: "acc1", consent });
    expect(service.linkAccount).toHaveBeenCalledWith(
      { plugin: "p0", requirement: "linear", scope: "app", account: "acc1", consent },
      owner,
    );
    expect(accountLinked).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: ownerId,
        plugin: "p0",
        requirement: "linear",
        scope: "app",
        consent,
      }),
    );

    await run(api, {
      type: "plugins.account.create",
      provider: "linear",
      method: "key",
      fields: { token: "secret" },
      link: { ...target, consent },
    });
    expect(service.createApiKeyAccount).toHaveBeenCalledWith(
      { provider: "linear", method: "key", fields: { token: "secret" } },
      owner,
    );
    expect(service.linkAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: "acc2" }),
      owner,
    );
    expect(accountLinked).toHaveBeenCalledTimes(2);

    service.linkAccount.mockRejectedValueOnce(
      new (await import("./engine-protocol.js")).PluginServiceError("consent-changed", "changed"),
    );
    await expect(
      run(api, { type: "plugins.account.link", ...target, accountId: "acc1", consent }),
    ).rejects.toMatchObject({ code: "conflict", reason: "plugin-consent-changed" });
    expect(accountLinked).toHaveBeenCalledTimes(2);
  });

  it("keeps agent access in Host settings and drives engine controls as the owner", async () => {
    const { api, service, store } = setup();
    const result = await run(api, {
      type: "plugins.access.set",
      pluginId: "p0",
      access: "read-only",
    });
    expect(result).toEqual({ type: "plugins.access.set", access: "read-only" });
    expect(store.setAccess).toHaveBeenCalledWith(ownerId, "p0", "read-only");
    await run(api, {
      type: "plugins.schedule.answer",
      pluginId: "p0",
      runId: "r1",
      action: "decline",
    });
    await run(
      api,
      { type: "plugins.workflow.start", pluginId: "p0", workflow: "w", input: { a: 1 } },
      "wk",
    );
    await run(api, {
      type: "plugins.account.unlink",
      pluginId: "p0",
      requirement: "linear",
      scope: "app",
      accountId: "acc1",
    });
    expect(service.manage.mock.calls.map(([input, context]) => [input, context])).toEqual([
      [{ operation: "schedules.answer", input: { run: "r1", action: "decline" } }, owner],
      [
        {
          operation: "workflowRuns.start",
          input: { app: "p0", workflow: "w", input: { a: 1 }, key: "wk" },
        },
        owner,
      ],
    ]);
    expect(service.unlinkAccount).toHaveBeenCalledWith(
      { plugin: "p0", requirement: "linear", scope: "app", account: "acc1" },
      owner,
    );
  });
});
