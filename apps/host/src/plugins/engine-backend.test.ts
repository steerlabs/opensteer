import { expect, test, vi } from "vitest";
import { Effect, Schema } from "effect";
import {
  AppId,
  AppSlug,
  VersionId,
  ToolName,
  Tool,
  ToolSearchListing,
  OwnerId,
  type ToolSearchInput,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import { CurrentMcpExecution } from "@opensteer/plugin-engine-mcp";
import { compositeBackend } from "./engine-backend.js";
import type { engineAccounts } from "./engine-accounts.js";

test("a same-named local provider cannot hide either plugin or an unrelated tool", async () => {
  const apps = ["github", "unrelated"].map((slug) => ({
    id: AppId.make(`app_${slug}`),
    slug: AppSlug.make(slug),
    name: slug,
    activeVersion: VersionId.make("dpl_fixture"),
  }));
  const engine = {
    apps: { list: () => Effect.succeed(apps) },
    tools: {
      search: (input: ToolSearchInput) =>
        Effect.succeed({
          items: input.targets.map((target, index) => ({
            target: index,
            also: [],
            tool: Schema.decodeUnknownSync(Tool)({
              app: target.app,
              version: "dpl_fixture",
              name: "read",
              description: "Read",
              inputSchema: { type: "object" },
              readOnly: true,
            }),
          })),
          remaining: 0,
          missing: [],
        }),
      call: (input: { app: string }) => Effect.succeed({ status: "completed", value: input.app }),
    },
  } as unknown as PluginEngine;
  const accounts = {
    accounts: () => Effect.succeed({ app: {}, user: {} }),
  } as unknown as ReturnType<typeof engineAccounts>;
  const localProviderReads = vi.fn();
  const backend = compositeBackend(
    engine,
    accounts,
    OwnerId.make("owner"),
    { caller: "fixture", mode: "automatic" },
    {
      authorize: () => Effect.succeed({ allowed: true, grants: {} }),
      providers: () =>
        Effect.sync(() => {
          localProviderReads();
          return [
            {
              id: "app_server_fixture",
              name: "github",
              slug: "github",
              version: "dpl_fixture",
              tools: [
                {
                  name: "read",
                  description: "Read",
                  inputSchema: { type: "object" },
                  readOnly: true,
                },
              ],
            },
          ];
        }),
      call: () => Effect.succeed({ kind: "value", value: "local" }),
    },
  );
  const listed = await Effect.runPromise(backend.listApps());
  expect(new Set(listed.map((app) => app.slug)).size).toBe(3);
  expect(listed.map((app) => app.id)).toEqual([...apps.map((app) => app.id), "app_server_fixture"]);
  const found = await Effect.runPromise(
    backend.searchTools({
      query: "read",
      offset: 0,
      limit: 100,
      targets: listed.map((app) => ({
        app: app.id,
        listing: ToolSearchListing.make(app.id),
        accounts: { app: {}, user: {} },
        labels: [],
        scopes: [],
      })),
    }),
  );
  expect(found.items.map(({ tool }) => tool.app)).toEqual(listed.map(({ id }) => id));
  const local = listed.find(({ id }) => id === "app_server_fixture")!;
  apps.push({ ...apps[0]!, id: AppId.make("app_adversarial"), slug: local.slug });
  const updated = await Effect.runPromise(backend.listApps());
  expect(updated.find(({ id }) => id === local.id)?.slug).toBe(local.slug);
  expect(new Set(updated.map(({ slug }) => slug)).size).toBe(updated.length);
  for (const app of listed) {
    localProviderReads.mockClear();
    const result = await Effect.runPromise(
      backend
        .callTool({ app: app.id, tool: ToolName.make("read"), input: {} })
        .pipe(Effect.provideService(CurrentMcpExecution, "fixture")),
    );
    expect(result).toMatchObject({
      status: "completed",
      value: app.id === "app_server_fixture" ? "local" : app.id,
    });
    if (app.id !== "app_server_fixture") expect(localProviderReads).not.toHaveBeenCalled();
  }
});

test("a listing kept while a plugin was Off marks its writes once the plugin is Read-only", async () => {
  const app = AppId.make("app_cloud");
  const tool = (name: string, readOnly: boolean) =>
    Schema.decodeUnknownSync(Tool)({
      app,
      version: "dpl_fixture",
      name,
      description: name,
      inputSchema: { type: "object" },
      readOnly,
    });
  const engine = {
    tools: {
      list: () =>
        Effect.succeed({
          version: VersionId.make("dpl_fixture"),
          accounts: { app: {}, user: {} },
          items: [tool("read", true), tool("write", false)],
          routers: [],
        }),
    },
  } as unknown as PluginEngine;
  const accounts = {
    accounts: () => Effect.succeed({ app: {}, user: {} }),
  } as unknown as ReturnType<typeof engineAccounts>;
  let access: "off" | "read-only" = "off";
  const backend = compositeBackend(
    engine,
    accounts,
    OwnerId.make("owner"),
    { caller: "fixture", mode: "automatic" },
    {
      authorize: () => Effect.sync(() => ({ allowed: true, grants: { [app]: access } })),
      providers: () => Effect.succeed([]),
      call: () => Effect.succeed({ kind: "value", value: null }),
    },
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(CurrentMcpExecution, "fixture")));
  const { listing } = await run(backend.searchableTools({ app }));
  const search = () =>
    run(
      backend.searchTools({
        query: "",
        offset: 0,
        limit: 10,
        targets: [{ app, listing, accounts: { app: {}, user: {} }, labels: [], scopes: [] }],
      }),
    );
  expect((await search()).items.map(({ tool }) => tool.blocked)).toEqual([undefined, undefined]);
  access = "read-only";
  const blocked = (await search()).items.map(({ tool }) => [tool.name, tool.blocked]);
  expect(blocked[0]).toEqual(["read", undefined]);
  expect(blocked[1]?.[0]).toBe("write");
  expect(blocked[1]?.[1]).toBeDefined();
});
