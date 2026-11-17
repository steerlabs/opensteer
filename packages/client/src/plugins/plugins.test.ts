import { describe, expect, it } from "vitest";
import { RequestSchema } from "@opensteer/core";
import { MockPlugins, mockPluginRequests } from "../mock/mock-plugins.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  pluginAccountComplete,
  pluginAccountValues,
  pluginCatalogReader,
  pluginInputContent,
  pluginInputForm,
  pluginRequestView,
  type PluginsHost,
} from "./index.js";

describe("plugin input forms", () => {
  const form = pluginInputForm(mockPluginRequests.input.schema);

  it("draws every property the flat form schema can carry", () => {
    expect(form.unsupported).toEqual([]);
    expect(form.fields.map(({ id, kind, required }) => [id, kind, required])).toEqual([
      ["team", "choice", true],
      ["title", "text", true],
      ["priority", "integer", false],
      ["notify", "boolean", false],
    ]);
    expect(form.fields[0]!.choices).toEqual([
      { value: "ENG", label: "Engineering" },
      { value: "DES", label: "Design" },
      { value: "OPS", label: "Operations" },
    ]);
  });

  it("sends typed values and leaves blank optional fields out", () => {
    expect(
      pluginInputContent(form, {
        team: ["DES"],
        title: [" Login crash "],
        priority: ["2"],
        notify: ["false"],
      }),
    ).toEqual({ content: { team: "DES", title: "Login crash", priority: 2, notify: false } });
    expect(pluginInputContent(form, { team: ["ENG"], title: ["x"], priority: [""] })).toEqual({
      content: { team: "ENG", title: "x" },
    });
  });

  it("refuses what the schema would refuse instead of sending it", () => {
    expect(pluginInputContent(form, { team: ["ENG"] })).toEqual({ problem: "Title is required." });
    expect(pluginInputContent(form, { team: ["ENG"], title: ["x"], priority: ["1.5"] })).toEqual({
      problem: "Priority needs a whole number.",
    });
  });

  it("can only decline a form with a property it cannot draw", () => {
    const nested = pluginInputForm({
      type: "object",
      properties: {
        address: { type: "object" },
        tags: { type: "array", items: { enum: ["a", "b"] } },
      },
    });
    expect(nested.unsupported).toEqual(["address"]);
    expect(nested.fields.map(({ kind }) => kind)).toEqual(["choices"]);
    expect("problem" in pluginInputContent(nested, { tags: ["a"] })).toBe(true);
  });
});

describe("plugin Requests", () => {
  const base = {
    callId: "c",
    cancellationReason: null,
    createdAt: "2026-11-16T20:00:00.000Z",
    id: "req_00000000-0000-4000-8000-000000000001",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: "run_00000000-0000-4000-8000-000000000001",
    originatingThreadId: "thr_00000000-0000-4000-8000-000000000001",
    requestedBy: "usr_00000000-0000-4000-8000-000000000001",
    requiredActor: "owner",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  };
  const plugin = { id: "plg_linear", name: "Linear", author: "agent" as const };

  it("shows the exact arguments an approval runs with", () => {
    const args = { id: "ENG-412", state: "Done", nested: { keep: [1, 2, 3] } };
    const request = RequestSchema.parse({
      ...base,
      kind: "plugin.approval",
      payload: { kind: "plugin.approval", executionId: "e", interactionId: "i" },
      presentation: {
        kind: "choice",
        title: "Linear: update_issue",
        options: [
          { id: "accept", label: "Allow once", hint: "allow-once" },
          { id: "decline", label: "Decline", hint: "reject-once" },
        ],
        plugin: {
          plugin,
          decision: { kind: "approval", executionId: "e", tool: "update_issue", arguments: args },
        },
      },
    });
    const view = pluginRequestView(request);
    expect(view?.kind).toBe("approval");
    expect(view?.kind === "approval" && JSON.parse(view.argumentsText)).toEqual(args);
  });

  it("names the requirement an account Request links and its consent", () => {
    const consent = {
      digest: "a".repeat(64),
      sites: ["https://api.github.com"],
      credential: "sealed",
    };
    const request = RequestSchema.parse({
      ...base,
      kind: "plugin.account",
      payload: {
        kind: "plugin.account",
        plugin: "plg_github",
        requirement: "github",
        scope: "app",
        consent,
      },
      presentation: {
        kind: "external",
        title: "Connect GitHub",
        subject: { kind: "plugin.account", id: "plg_github" },
        plugin: {
          plugin: { ...plugin, id: "plg_github", name: "GitHub" },
          decision: { kind: "account", requirement: "github", scope: "app", consent },
        },
      },
    });
    expect(pluginRequestView(request)).toEqual({
      kind: "account",
      plugin: { id: "plg_github", name: "GitHub", author: "agent" },
      target: { pluginId: "plg_github", requirement: "github", scope: "app" },
      consent,
    });
  });
});

describe("API-key accounts", () => {
  const fields = [
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
      title: "Region",
      description: null,
      type: "string",
      choices: null,
      required: false,
      plain: true,
    },
    {
      name: "port",
      title: "Port",
      description: null,
      type: "integer",
      choices: null,
      required: false,
      plain: true,
    },
  ] as const;

  it("sends only filled optional fields, typed", () => {
    expect(pluginAccountValues(fields, { token: "sk", region: "", port: "8080" })).toEqual({
      token: "sk",
      port: 8080,
    });
    expect(pluginAccountComplete(fields, { token: "", port: "" })).toBe(false);
    expect(pluginAccountComplete(fields, { token: "sk", port: "80.5" })).toBe(false);
    expect(pluginAccountComplete(fields, { token: "sk" })).toBe(true);
  });
});

describe("catalog paging", () => {
  function host(plugins: MockPlugins): PluginsHost {
    const reads = plugins.reads();
    return {
      rpc: {
        "plugins.catalog.list": (input: Parameters<(typeof reads)["plugins.catalog.list"]>[0]) =>
          reads["plugins.catalog.list"](input, {} as never),
      },
      dispatch: () => Promise.reject(new Error("unused")),
    } as unknown as PluginsHost;
  }

  it("pages the whole catalog by cursor and pages a search on its own", async () => {
    const plugins = new MockPlugins({
      changed: () => {},
      accountLinked: () => {},
      scenario: "default",
    });
    const read = pluginCatalogReader(host(plugins), "");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await read(cursor);
      seen.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(plugins.catalog.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect(plugins.catalog.length).toBeGreaterThan(200);

    const search = pluginCatalogReader(host(plugins), "  linear ");
    const first = await search(null);
    expect(first.items.every(({ name }) => name.toLowerCase().includes("linear"))).toBe(true);
    // A cursor belongs to the search it came from.
    const whole = await read(null);
    await expect(search(whole.nextCursor)).rejects.toThrow(/restart the listing/u);
  });
});

describe("mock Host plugin Requests", () => {
  it("answers an account Request only by linking an account", async () => {
    const client = new MockHostClient();
    await client.load();
    const pending = () =>
      Object.values(client.getSnapshot().requests)
        .flat()
        .filter((request) => request.kind.startsWith("plugin."));
    const account = pending().find((request) => request.kind === "plugin.account")!;
    await expect(
      client.dispatch({
        type: "request.respond",
        idempotencyKey: "k1",
        requestId: account.id,
        response: { kind: "external", value: { decision: "fulfilled" } },
      }),
    ).rejects.toThrow(/Link an account/u);
    const view = pluginRequestView(account);
    if (view?.kind !== "account") throw new Error("not an account Request");
    await client.dispatch({
      type: "plugins.account.link",
      idempotencyKey: "k2",
      ...view.target,
      accountId: "acc_github_old",
      consent: view.consent,
    });
    expect(pending().some((request) => request.id === account.id)).toBe(false);
  });
});
