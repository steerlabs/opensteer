import { describe, expect, it, vi } from "vitest";
import { RequestSchema } from "@opensteer/core";
import { MockPlugins, mockPluginRequests } from "../mock/mock-plugins.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  readPluginPageView,
  readPluginWebhookSetup,
  removePluginWebhook,
  confirmPluginWebhookRemoval,
  setPluginAccess,
  pluginAccountComplete,
  pluginAccountValues,
  pluginCatalogReader,
  pluginInputContent,
  pluginInputForm,
  pluginRequestView,
  completePluginWebhookSetup,
  pluginAccountRemoval,
  pluginAccountRows,
  pluginConsentLines,
  pluginEngineNotice,
  pluginWebhookSetupCompletion,
  pluginWebhookSetupForm,
  PluginWorkflowRuns,
  type PluginsHost,
} from "./index.js";
import type { PluginWorkflowRunView } from "@opensteer/protocol";

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

describe("plugin page and webhook clients", () => {
  it("obtains a viewing reference, respects unavailable pages, and completes webhook cleanup once", async () => {
    const mock = new MockPlugins({ changed: () => {}, accountLinked: () => {} });
    const host: PluginsHost = {
      rpc: mock.reads() as PluginsHost["rpc"],
      dispatch: (input) => mock.command(input as Parameters<MockPlugins["command"]>[0]),
    };
    const page = await readPluginPageView(host, "plg_linear", "dark");
    expect(page.entryUrl).toMatch(/^data:text\/html,/);
    await setPluginAccess(host, "plg_linear", "off");
    await expect(readPluginPageView(host, "plg_linear", "dark")).rejects.toThrow(
      "Turn on this plugin",
    );
    await setPluginAccess(host, "plg_linear", "all");
    await expect(
      confirmPluginWebhookRemoval(host, "plg_linear", "whk_linear_issues"),
    ).rejects.toThrow("Remove the webhook before");
    await removePluginWebhook(host, "plg_linear", "whk_linear_issues");
    expect(await readPluginWebhookSetup(host, "plg_linear", "whk_linear_issues")).toMatchObject({
      step: "remove",
      webhook: { status: "stopping" },
    });
    await confirmPluginWebhookRemoval(host, "plg_linear", "whk_linear_issues");
    await expect(readPluginWebhookSetup(host, "plg_linear", "whk_linear_issues")).rejects.toThrow(
      "gone",
    );
  });
});

describe("finishing a manual webhook setup", () => {
  const mockHost = () => {
    const mock = new MockPlugins({ changed: () => {}, accountLinked: () => {} });
    const host: PluginsHost = {
      rpc: mock.reads() as PluginsHost["rpc"],
      dispatch: (input) => mock.command(input as Parameters<MockPlugins["command"]>[0]),
    };
    return { mock, host };
  };

  it("asks for the declared fields and the service's secret, and sends exactly them", async () => {
    const { host } = mockHost();
    const setup = await readPluginWebhookSetup(host, "plg_linear", "whk_linear_projects");
    const form = pluginWebhookSetupForm(setup);
    expect(form.fields.fields.map(({ id, required }) => [id, required])).toEqual([
      ["workspace", true],
    ]);
    expect(form.secret).toEqual({ kind: "provider" });
    expect(pluginWebhookSetupCompletion("plg_linear", setup, { workspace: ["acme"] }, " ")).toEqual(
      { problem: "Paste the signing secret the service shows you." },
    );
    expect(pluginWebhookSetupCompletion("plg_linear", setup, {}, "whsec")).toEqual({
      problem: "Workspace ID is required.",
    });
    const done = pluginWebhookSetupCompletion(
      "plg_linear",
      setup,
      { workspace: [" acme "] },
      " whsec_1 ",
    );
    if (!("command" in done)) throw new Error(done.problem);
    expect(done.command).toEqual({
      pluginId: "plg_linear",
      webhookId: "whk_linear_projects",
      revision: "mock-webhook-1",
      state: { workspace: "acme" },
      secret: "whsec_1",
    });
    await completePluginWebhookSetup(host, done.command);
    expect(await readPluginWebhookSetup(host, "plg_linear", "whk_linear_projects")).toMatchObject({
      step: "done",
      webhook: { status: "active" },
    });
  });

  it("completes a setup with no fields and never sends back a secret Opensteer made", async () => {
    const { host } = mockHost();
    const setup = await readPluginWebhookSetup(host, "plg_stripe", "whk_stripe_payments");
    const form = pluginWebhookSetupForm(setup);
    expect(form.fields.fields).toEqual([]);
    expect(form.secret).toMatchObject({ kind: "generated" });
    const done = pluginWebhookSetupCompletion("plg_stripe", setup, {}, "typed anyway");
    if (!("command" in done)) throw new Error(done.problem);
    expect(done.command).not.toHaveProperty("secret");
    expect(done.command.state).toEqual({});
    await completePluginWebhookSetup(host, done.command);
    // The completed setup has nothing left to send.
    const after = await readPluginWebhookSetup(host, "plg_stripe", "whk_stripe_payments");
    expect(pluginWebhookSetupCompletion("plg_stripe", after, {}, "")).toEqual({
      problem: "This webhook isn't waiting for setup anymore.",
    });
  });
});

describe("workflow runs", () => {
  const run = (id: string, status: PluginWorkflowRunView["status"], day: number) => ({
    id,
    workflow: "Import",
    status,
    createdAt: `2026-11-${String(day).padStart(2, "0")}T10:00:00.000Z`,
    failure: null,
  });

  it("shows every live run first, pages the rest by cursor, and rereads loaded pages", async () => {
    let finished = false;
    // Page order follows run ids: the first page is neither the newest nor the live runs.
    const read = vi.fn(async (cursor: string | null) =>
      cursor === "2"
        ? {
            runs: [run("live_late", finished ? "complete" : "running", 3), run("old_8", "complete", 8)],
            cursor: null,
          }
        : { runs: [1, 2, 3, 4, 5, 6, 7].map((day) => run(`old_${day}`, "complete", day)), cursor: "2" },
    );
    const runs = new PluginWorkflowRuns(read);
    await runs.refresh();
    expect(runs.getState().visible.map(({ id }) => id)).toEqual([
      "old_7",
      "old_6",
      "old_5",
      "old_4",
      "old_3",
    ]);
    expect(runs.getState().more).toBe(true);
    await runs.showMore();
    // The live run on the next page comes first, before newer finished ones.
    expect(runs.getState().visible[0]).toMatchObject({ id: "live_late", status: "running" });
    expect(runs.getState().visible).toHaveLength(9);
    expect(runs.getState().more).toBe(false);
    finished = true;
    read.mockClear();
    await runs.refresh();
    expect(read.mock.calls).toEqual([[null], ["2"]]);
    expect(runs.getState().visible.find(({ id }) => id === "live_late")?.status).toBe("complete");
  });

  it("keeps a failed read a failure, not an empty list", async () => {
    const runs = new PluginWorkflowRuns(() => Promise.reject(new Error("offline")));
    await runs.refresh();
    expect(runs.getState()).toMatchObject({ loaded: false, loading: false, visible: [] });
    expect(runs.getState().error).toBeInstanceOf(Error);
  });
});

describe("saved accounts", () => {
  it("names the plugins removing an account breaks, and none for an orphan", () => {
    const mock = new MockPlugins({ changed: () => {}, accountLinked: () => {} });
    const rows = pluginAccountRows(
      mock.accounts,
      mock.plugins.map((plugin) => mock.detail(plugin)),
    );
    const linear = rows.find(({ account }) => account.id === "acc_linear_work")!;
    expect(linear).toMatchObject({
      providerName: "Linear",
      links: [{ pluginId: "plg_linear", pluginName: "Linear" }],
    });
    expect(pluginAccountRemoval(linear).message).toContain("Linear loses this account");
    const orphan = rows.find(({ account }) => account.id === "acc_github_old")!;
    expect(orphan.links).toEqual([]);
    expect(pluginAccountRemoval(orphan).message).toMatch(/^No plugin uses it\. .*even if/u);
  });
});

describe("words a person reads", () => {
  it("never says a credential plugin code receives can only go to its sites", () => {
    const lines = (credential: "sealed" | "value") =>
      pluginConsentLines({
        consent: { digest: "a".repeat(64), sites: ["https://api.resend.com"], credential },
        author: "agent",
        pluginName: "Resend",
        providerName: "Resend",
      }).map(({ text }) => text);
    expect(lines("value").join(" ")).not.toMatch(/only|sealed|Resend's code/u);
    expect(lines("value")).toContain(
      "This plugin's code receives your Resend credential itself and could send it to any site.",
    );
    expect(lines("sealed")[0]).toBe("Your Resend credential can only be sent to api.resend.com.");
    expect(lines("sealed").join(" ")).not.toMatch(/sealed handle|Resend's code/u);
  });

  it("says what to do when the sandbox can't run here, keeping the Host's reason", () => {
    const reason = "Plugins are unavailable: workerd cannot run on this darwin/arm64 system";
    expect(pluginEngineNotice({ status: "unavailable", reason })).toEqual({
      tone: "error",
      text: "Plugins need a newer version of macOS. Update macOS on this computer to use them.",
      detail: reason,
    });
    expect(
      pluginEngineNotice({
        status: "unavailable",
        reason: "Plugins are unavailable: workerd has no binary for win32/arm64",
      })?.text,
    ).toBe("Plugins aren't supported on this computer.");
  });
});
