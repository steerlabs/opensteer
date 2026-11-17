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
  options: {
    plugins?: number;
    tools?: number;
    versions?: number;
    local?: number;
    engineDown?: boolean;
    /** Not started yet: a read starts it and the list waits on this. */
    starting?: Promise<void>;
  } = {},
) {
  let engineStatus: "idle" | "ready" = options.starting ? "idle" : "ready";
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
    state: vi.fn(() => ({ status: engineStatus, generation: 1 })),
    installed: vi.fn(async (_input?: unknown, _context?: unknown) => {
      if (options.starting) {
        await options.starting;
        engineStatus = "ready";
      }
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
        links: index === 0 ? [{ requirement: "linear", scope: "app", account: "acc1" }] : [],
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
      versions: Array.from({ length: options.versions ?? 2 }, (_, index) => ({
        id: `${id}-v${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString(),
      })),
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
    accounts: vi.fn(async () => [
      { id: "acc1", provider: "linear", label: "Work" },
      { id: "acc9", provider: "old_crm", label: "Orphan" },
    ]),
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

  it("pages the installed list so every plugin is reachable, those needing the person first", async () => {
    const { api } = setup({ plugins: 130 });
    const reads = api.reads();
    const first = await reads["plugins.installed.list"]({}, context(ownerId));
    if (!first.ok) throw new Error("refused");
    const view = hostApi["plugins.installed.list"].success.parse(first.data);
    expect(view.engine).toEqual({ status: "ready" });
    expect(view.plugins).toHaveLength(50);
    expect(view.plugins!.slice(0, 2).map(({ status }) => status)).not.toContain("ready");
    const seen = [...view.plugins!];
    let cursor = view.cursor;
    while (cursor) {
      const page = await reads["plugins.installed.page"]({ cursor }, context(ownerId));
      if (!page.ok) throw new Error("refused");
      seen.push(...hostApi["plugins.installed.page"].success.parse(page.data).plugins);
      cursor = page.data.cursor;
    }
    expect(new Set(seen.map(({ id }) => id)).size).toBe(130);
    expect(seen).toHaveLength(130);
    // Everything that needs the person comes before anything ready.
    expect(seen.findIndex(({ status }) => status === "ready")).toBe(128);
    const byId = new Map(seen.map((entry) => [entry.id, entry]));
    expect(byId.get("p0")).toMatchObject({
      status: "ready",
      accounts: { required: 1, linked: 1 },
    });
    expect(byId.get("p1")).toMatchObject({ status: "not-built" });
    await expect(
      reads["plugins.installed.page"]({ cursor: "bm90LWEtY3Vyc29y" }, context(ownerId)),
    ).rejects.toMatchObject({ code: "bad_request", reason: "plugin-cursor-stale" });
  });

  it("lists local tools as counted summaries without waiting for the engine to start", async () => {
    const started = Promise.withResolvers<void>();
    const { api, service, changed } = setup({ starting: started.promise, local: 120 });
    await run(api, { type: "plugins.access.set", pluginId: "app_device_con0", access: "off" });
    changed.mockClear();
    const result = await api.reads()["plugins.installed.list"]({}, context(ownerId));
    if (!result.ok) throw new Error("refused");
    const view = hostApi["plugins.installed.list"].success.parse(result.data);
    expect(view).toMatchObject({ engine: { status: "starting" }, plugins: null, cursor: null });
    expect(view.local).toHaveLength(100);
    expect(view.local[0]).toEqual({
      id: "app_device_con0",
      kind: "device-app",
      name: "calendar-mac-000",
      title: "Calendar on Mac",
      computer: { id: "run_1", name: "Mac" },
      unavailable: null,
      toolCount: 600,
      readOnlyToolCount: 300,
      access: "off",
    });
    // A second open while it starts does not start it again.
    await api.reads()["plugins.installed.list"]({}, context(ownerId));
    expect(service.installed).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    started.resolve();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(ownerId), { timeout: 1_000 });
    const ready = await api.reads()["plugins.installed.list"]({}, context(ownerId));
    expect(ready.ok && ready.data.plugins).toHaveLength(3);

    const one = await api.reads()["plugins.local.get"]({ id: "app_device_con1" }, context(ownerId));
    if (!one.ok) throw new Error("refused");
    expect(hostApi["plugins.local.get"].success.parse(one.data)).toMatchObject({
      access: "all",
      unavailable: "Mac is offline.",
      toolCount: 600,
    });
    expect(one.data.tools).toHaveLength(500);
    await expect(
      api.reads()["plugins.local.get"]({ id: "app_device_gone" }, context(ownerId)),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps local tools listed while the engine is down", async () => {
    const { api } = setup({ engineDown: true });
    const result = await api.reads()["plugins.installed.list"]({}, context(ownerId));
    expect(result.ok && result.data).toMatchObject({
      plugins: null,
      local: [{ id: "app_device_con0" }],
    });
  });

  it("sends a detail's first tools, skills and versions and pages the rest to the end", async () => {
    const { api } = setup({ tools: 120, versions: 75 });
    const reads = api.reads();
    const result = await reads["plugins.get"]({ pluginId: "p0" }, context(ownerId));
    if (!result.ok) throw new Error("refused");
    const view = hostApi["plugins.get"].success.parse(result.data);
    expect(view.tools?.map(({ name }) => name)).toEqual(
      Array.from({ length: 120 }, (_, index) => `tool_${index}`)
        .sort()
        .slice(0, 8),
    );
    expect(view).toMatchObject({ toolCount: 120, skillCount: 1, versionCount: 75 });
    expect(view.versions.map(({ id, active }) => [id, active])).toEqual([
      ["p0-v75", false],
      ["p0-v74", false],
      ["p0-v73", false],
      ["p0-v72", false],
      ["p0-v71", false],
    ]);
    const all = async (
      read: (cursor: string | undefined) => Promise<{ ids: string[]; cursor: string | null }>,
    ) => {
      const items: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await read(cursor);
        items.push(...page.ids);
        cursor = page.cursor ?? undefined;
      } while (cursor);
      return items;
    };
    const target = (cursor: string | undefined) => ({
      pluginId: "p0",
      ...(cursor ? { cursor } : {}),
    });
    const tools = await all(async (cursor) => {
      const page = await reads["plugins.tools.list"](target(cursor), context(ownerId));
      if (!page.ok) throw new Error("refused");
      const data = hostApi["plugins.tools.list"].success.parse(page.data);
      return { ids: data.tools.map(({ name }) => name), cursor: data.cursor };
    });
    expect(tools).toHaveLength(120);
    expect(new Set(tools).size).toBe(120);
    const versions = await all(async (cursor) => {
      const page = await reads["plugins.versions.list"](target(cursor), context(ownerId));
      if (!page.ok) throw new Error("refused");
      const data = hostApi["plugins.versions.list"].success.parse(page.data);
      return { ids: data.versions.map(({ id }) => id), cursor: data.cursor };
    });
    expect(versions).toHaveLength(75);
    expect(versions[74]).toBe("p0-v1");
    // A cursor from one plugin's list never reads as another's.
    const page = await reads["plugins.tools.list"]({ pluginId: "p0" }, context(ownerId));
    await expect(
      reads["plugins.tools.list"](
        { pluginId: "p3", cursor: page.ok ? page.data.cursor! : "x" },
        context(ownerId),
      ),
    ).rejects.toMatchObject({ reason: "plugin-cursor-stale" });
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

  it("lists saved accounts with their provider's name and the plugins they serve, in one read", async () => {
    const { api, service } = setup();
    const result = await api.reads()["plugins.accounts.list"]({}, context(ownerId));
    if (!result.ok) throw new Error("refused");
    expect(hostApi["plugins.accounts.list"].success.parse(result.data).accounts).toEqual([
      {
        id: "acc1",
        provider: "linear",
        providerName: "Linear",
        label: "Work",
        links: [{ pluginId: "p0", pluginName: "Plugin p0" }],
      },
      { id: "acc9", provider: "old_crm", providerName: "Old crm", label: "Orphan", links: [] },
    ]);
    expect(service.detail).not.toHaveBeenCalled();
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
    await run(
      api,
      { type: "plugins.install", source: { kind: "catalog", catalogId: "linear" } },
      "catalog-install",
    );
    await run(
      api,
      {
        type: "plugins.install",
        source: { kind: "openapi", url: "https://api.example.com/openapi.json", name: "Example" },
      },
      "url-install",
    );
    expect(service.install.mock.calls.map(([input, context]) => [input, context])).toEqual([
      [
        {
          kind: "catalog",
          id: "linear",
          key: JSON.stringify([ownerId, "plugins.install", "catalog-install"]),
        },
        owner,
      ],
      [
        {
          kind: "openapi",
          url: "https://api.example.com/openapi.json",
          name: "Example",
          key: JSON.stringify([ownerId, "plugins.install", "url-install"]),
        },
        owner,
      ],
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

    await run(
      api,
      {
        type: "plugins.account.create",
        provider: "linear",
        method: "key",
        fields: { token: "secret" },
        link: { ...target, consent },
      },
      "create-account",
    );
    expect(service.createApiKeyAccount).toHaveBeenCalledWith(
      {
        provider: "linear",
        method: "key",
        fields: { token: "secret" },
        key: JSON.stringify([ownerId, "plugins.account.create", "create-account"]),
      },
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
          input: {
            app: "p0",
            workflow: "w",
            input: { a: 1 },
            key: JSON.stringify([ownerId, "plugins.workflow.start", "wk"]),
          },
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
