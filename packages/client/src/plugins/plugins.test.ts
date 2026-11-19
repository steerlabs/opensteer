import { describe, expect, it, vi } from "vitest";
import { RequestSchema } from "@opensteer/core";
import { MockPlugins, mockPluginRequests } from "../mock/mock-plugins.js";
import type { HostApiCommand } from "@opensteer/protocol";
import { controlledClientSession } from "../test-support/client-connection.js";
import { MockHostClient } from "../mock/mock-host-client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
import { PagedList, type PagedListState } from "../team/paged-list.js";
import {
  readPluginWebhookSetup,
  removePluginWebhook,
  confirmPluginWebhookRemoval,
  setPluginAccess,
  pluginAccountComplete,
  createPluginAccountAttempt,
  pluginAccountValues,
  pluginCatalogListView,
  pluginCatalogReader,
  pluginCatalogUnavailable,
  pluginInputContent,
  pluginInputForm,
  pluginRequestView,
  completePluginWebhookSetup,
  pluginAccountRemoval,
  readPluginAccounts,
  pluginConsentLines,
  pluginEngineNotice,
  pluginEmptyToolsText,
  pluginLocalToolStatus,
  pluginWebhookSetupCompletion,
  pluginWebhookSetupForm,
  PluginWorkflowRuns,
  pluginScheduledRunLabel,
  pluginWorkflowRunLabel,
  type PluginCatalogEntryView,
  type PluginsHost,
  pluginWebhookStatusText,
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

describe("a catalog the Host can't reach", () => {
  const entry: PluginCatalogEntryView = {
    id: "mail",
    name: "Mail",
    description: "d",
    icon: null,
    auth: [],
  };
  function host(pages: { items: PluginCatalogEntryView[]; catalog?: "listed" | "unavailable" }[]) {
    return {
      rpc: {
        "plugins.catalog.list": async () => ({
          ok: true,
          data: { cursor: pages.length > 1 ? "next" : null, ...pages.shift()! },
        }),
      },
      dispatch: () => Promise.reject(new Error("unused")),
    } as unknown as PluginsHost;
  }
  async function settle(list: { getState(): PagedListState<unknown, unknown> }) {
    await vi.waitFor(() => expect(list.getState().loading).toBe(false));
    return list.getState();
  }

  it("fails the list's read with a reason to try again, never an empty catalog", async () => {
    const list = new PagedList(
      controlledClientSession(),
      pluginCatalogReader(host([{ items: [], catalog: "unavailable" }]), ""),
    );
    const stop = list.subscribe(() => {});
    const state = await settle(list);
    stop();
    expect(state.error).toMatchObject({ code: "read-failed", reason: pluginCatalogUnavailable });
    expect(pluginCatalogListView(state, "")).toEqual({
      kind: "failed",
      text: "The plugin catalog can't be reached right now.",
      retry: true,
    });
  });

  it("keeps the entries already shown when a later page can't be read", async () => {
    const list = new PagedList(
      controlledClientSession(),
      pluginCatalogReader(
        host([
          { items: [entry], catalog: "listed" },
          { items: [], catalog: "unavailable" },
        ]),
        "",
      ),
    );
    const stop = list.subscribe(() => {});
    await settle(list);
    await list.more();
    const state = list.getState();
    stop();
    expect(state.items).toEqual([entry]);
    expect(pluginCatalogListView(state, "")).toEqual({
      kind: "entries",
      issue: { text: "The plugin catalog can't be reached right now.", retry: true },
    });
  });

  it("says the catalog can't be reached when a reconnect refresh fails, and clears it on recovery", async () => {
    const unreachable = "The plugin catalog can't be reached right now.";
    for (const [first, view] of [
      [[] as PluginCatalogEntryView[], { kind: "failed", text: unreachable, retry: true }],
      [[entry], { kind: "entries", issue: { text: unreachable, retry: true } }],
    ] as const) {
      const session = controlledClientSession();
      const pages: { items: PluginCatalogEntryView[]; catalog?: "listed" | "unavailable" }[] = [
        { items: [...first], catalog: "listed" },
        { items: [], catalog: "unavailable" },
        { items: [entry], catalog: "listed" },
      ];
      const list = new PagedList(session, pluginCatalogReader(host(pages), "x"));
      const stop = list.subscribe(() => {});
      await settle(list);
      // The link drops and comes back; the Host answers, but can't reach the catalog.
      session.change({ phase: "recovering", epoch: 2 });
      session.change({ phase: "ready", readyRevision: 2 });
      await vi.waitFor(() => expect(list.getState().error).not.toBeNull());
      expect(list.getState().items).toEqual(first);
      expect(pluginCatalogListView(list.getState(), "x")).toEqual(view);
      // Losing the link again keeps saying so rather than the stale result.
      session.change({ phase: "recovering", epoch: 3 });
      expect(pluginCatalogListView(list.getState(), "x")).toEqual(view);
      session.change({ phase: "ready", readyRevision: 3 });
      await vi.waitFor(() => expect(list.getState().items).toEqual([entry]));
      expect(pluginCatalogListView(list.getState(), "x")).toEqual({ kind: "entries", issue: null });
      stop();
    }
  });

  it("says empty or no match only after a read that listed, including from an older Host", async () => {
    for (const page of [{ items: [], catalog: "listed" as const }, { items: [] }]) {
      const list = new PagedList(controlledClientSession(), pluginCatalogReader(host([page]), "x"));
      const stop = list.subscribe(() => {});
      const state = await settle(list);
      stop();
      expect(pluginCatalogListView(state, "x")).toEqual({
        kind: "empty",
        text: "Nothing in the catalog matches “x”.",
      });
    }
    expect(pluginCatalogListView({ loading: false, items: [], error: null }, "")).toEqual({
      kind: "empty",
      text: "The catalog is empty.",
    });
    expect(pluginCatalogListView({ loading: true, items: [], error: null }, "")).toEqual({
      kind: "loading",
    });
    // Any other failed read keeps its own words.
    expect(
      pluginCatalogListView(
        { loading: false, items: [], error: { code: "read-failed", resource: "this list" } },
        "",
      ),
    ).toEqual({ kind: "failed", text: "Couldn't load the catalog.", retry: true });
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
    const view = () =>
      host.rpc["plugins.page.view"]({ pluginId: "plg_linear", theme: "dark" }).then(
        unwrapRpcResult,
      );
    expect((await view()).entryUrl).toMatch(/^data:text\/html,/);
    await setPluginAccess(host, "plg_linear", "off");
    await expect(view()).rejects.toThrow("Plugin page is unavailable");
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

describe("run labels", () => {
  it("says what to do about a run that ended stale, and shows any other failure's reason", () => {
    const workflow = {
      id: "wfr_1",
      workflow: "Import",
      status: "errored" as const,
      createdAt: "2026-11-01T10:00:00.000Z",
    };
    expect(pluginWorkflowRunLabel({ ...workflow, failure: "stale" })).toBe(
      "Stopped because the plugin changed after this was started. Steps it had already finished stay done; check them, then start it again.",
    );
    expect(pluginWorkflowRunLabel({ ...workflow, failure: "execution" })).toBe("Failed: execution");
    const scheduled = {
      id: "run_1",
      scheduleId: "sch_1",
      name: "Daily",
      status: "failed" as const,
      scheduledAt: null,
      expiresAt: null,
      approval: null,
    } as unknown as Parameters<typeof pluginScheduledRunLabel>[0];
    expect(pluginScheduledRunLabel({ ...scheduled, failure: "stale" })).toBe(
      "Not run because the plugin changed after this was saved; approve it again when it next asks.",
    );
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

  it("always shows the Host's live runs, pages completed history, and refreshes older live runs by id", async () => {
    let finished = false;
    // The Host's order: live first, then newest.
    const read = vi.fn(async (cursor: string | null, ids?: readonly string[]) =>
      ids
        ? { runs: [run("live_1", "complete", 3)], cursor: null }
        : cursor === "2"
          ? { runs: [run("done_2", "complete", 2), run("done_1", "complete", 1)], cursor: null }
          : {
              runs: [
                ...(finished ? [] : [run("live_1", "running", 3)]),
                run("live_2", "waiting", 4),
                ...[9, 8, 7, 6, 5, 4, 3].map((day) => run(`done_${day}`, "complete", day)),
              ],
              cursor: "2",
            },
    );
    const runs = new PluginWorkflowRuns(read);
    await runs.refresh();
    expect(runs.getState().visible.map(({ id }) => id)).toEqual([
      "live_1",
      "live_2",
      "done_9",
      "done_8",
      "done_7",
      "done_6",
      "done_5",
    ]);
    expect(runs.getState().more).toBe(true);
    await runs.showMore();
    expect(
      runs
        .getState()
        .visible.map(({ id }) => id)
        .slice(-2),
    ).toEqual(["done_2", "done_1"]);
    expect(runs.getState().visible).toHaveLength(11);
    expect(runs.getState().more).toBe(false);
    finished = true;
    read.mockClear();
    await runs.refresh();
    expect(read.mock.calls).toEqual([[null], [null, ["live_1"]]]);
    expect(runs.getState().visible.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["done_2", "done_1"]),
    );
    expect(runs.getState().visible.find(({ id }) => id === "live_1")?.status).toBe("complete");
    expect(runs.getState().visible[0]?.id).toBe("live_2");
  });

  it("keeps a failed read a failure, not an empty list", async () => {
    const runs = new PluginWorkflowRuns(() => Promise.reject(new Error("offline")));
    await runs.refresh();
    expect(runs.getState()).toMatchObject({ loaded: false, loading: false, visible: [] });
    expect(runs.getState().error).toBeInstanceOf(Error);
  });
});

describe("saved accounts", () => {
  it("names the plugins removing an account breaks, and none for an orphan", async () => {
    const mock = new MockPlugins({ changed: () => {}, accountLinked: () => {} });
    const accounts = await readPluginAccounts({ rpc: mock.reads() as PluginsHost["rpc"] });
    const linear = accounts.find(({ id }) => id === "acc_linear_work")!;
    expect(linear).toMatchObject({
      providerName: "Linear",
      links: [{ pluginId: "plg_linear", pluginName: "Linear" }],
    });
    expect(pluginAccountRemoval(linear).message).toContain("Linear loses this account");
    const orphan = accounts.find(({ id }) => id === "acc_github_old")!;
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
    expect(lines("value")).toEqual(
      expect.arrayContaining([
        "This plugin says it uses your Resend credential with api.resend.com, but its code can send it elsewhere.",
        "This plugin's code receives your Resend credential itself and could send it to any site.",
      ]),
    );
    const unnamed = pluginConsentLines({
      consent: { digest: "a".repeat(64), credential: "value", sites: ["api.example.com"] },
      author: "agent",
      pluginName: "Example",
      providerName: null,
    });
    expect(unnamed.find((line) => line.key === "sites")?.text).toContain("can send it elsewhere");
    expect(unnamed.find((line) => line.key === "credential")?.text).toContain(
      "receives the credential itself",
    );
    expect(lines("sealed")[0]).toBe("Your Resend credential can only be sent to api.resend.com.");
    expect(lines("sealed").join(" ")).not.toMatch(/sealed handle|Resend's code/u);
  });

  it("says what to do when the sandbox can't run here from the Host's code, keeping its reason", () => {
    const reason = "Plugins are unavailable: workerd cannot run on this darwin/arm64 system";
    expect(
      pluginEngineNotice({
        status: "unavailable",
        reason,
        unavailable: { code: "unsupported-system", minimumMacOS: "13.5" },
      }),
    ).toEqual({
      tone: "error",
      text: "Plugins need macOS 13.5 or later. Update macOS on this computer to use them.",
      detail: reason,
    });
    expect(
      pluginEngineNotice({
        status: "unavailable",
        reason: "Plugins are unavailable: workerd has no binary for win32/arm64",
        unavailable: { code: "unsupported-system" },
      })?.text,
    ).toBe("Plugins aren't supported on this computer.");
    // The reason's wording is detail only; without a code nothing is read into it.
    expect(pluginEngineNotice({ status: "unavailable", reason })?.text).toBe(
      "Plugins aren't working on this computer right now.",
    );
  });
});

it("explains that tools are off even when accounts and tools are absent", () => {
  const plugin = { access: "off", status: "needs-account" } as const;
  expect(pluginEmptyToolsText({ plugin, tools: null })).toBe("Tools are off for agents.");
});

it("shows the Host's unavailable detail, with waiting and off taking precedence", () => {
  const server = {
    id: "app_server_pending",
    kind: "local-server",
    name: "pending",
    title: "Pending",
    computer: { id: "fixture", name: "Test Mac" },
    unavailable: "Test Mac is offline. Open Opensteer on Test Mac.",
    toolCount: 0,
    readOnlyToolCount: 0,
    access: "all",
  } as const;
  expect(pluginLocalToolStatus(server)).toEqual({ label: server.unavailable, tone: "attention" });
  expect(pluginLocalToolStatus({ ...server, waitingForLaunchApproval: true })).toEqual({
    label: "Waiting for approval",
    tone: "attention",
  });
  expect(pluginLocalToolStatus({ ...server, access: "off" })).toEqual({
    label: "Off for agents",
    tone: "muted",
  });
});

it("uses the original account creation receipt to recover a lost answer", async () => {
  const session = controlledClientSession();
  const account = { id: "acc_key", provider: "linear", label: "Key" };
  type CreateAccount = Extract<HostApiCommand, { type: "plugins.account.create" }>;
  const dispatch = vi.fn(async (command: CreateAccount) => {
    expect(command.type).toBe("plugins.account.create");
    return { type: command.type, account };
  });
  const create = createPluginAccountAttempt({
    ...session,
    rpc: {} as never,
    dispatch: dispatch as never,
  });
  const input = {
    provider: "linear",
    method: "key",
    fields: { key: "fixture-key", token: "fixture-token" },
  };
  dispatch.mockRejectedValueOnce(new Error("The answer was lost"));
  await expect(create(input)).rejects.toThrow("The answer was lost");
  await expect(
    create({ ...input, fields: { token: input.fields.token, key: input.fields.key } }),
  ).resolves.toEqual(account);
  expect(dispatch.mock.calls[1]?.[0]).toEqual(dispatch.mock.calls[0]?.[0]);
  dispatch.mockRejectedValueOnce(new Error("The answer was lost"));
  await expect(create(input)).rejects.toThrow("The answer was lost");
  await create({ ...input, fields: { key: "edited-key" } });
  expect(dispatch.mock.calls[3]?.[0].idempotencyKey).not.toBe(
    dispatch.mock.calls[2]?.[0].idempotencyKey,
  );
  dispatch.mockRejectedValueOnce(new Error("The answer was lost"));
  await expect(create(input)).rejects.toThrow("The answer was lost");
  const scope = session.connection.getSnapshot().scope!;
  session.change({ scope: { ...scope, loginId: "other-login" } });
  await create(input);
  expect(dispatch.mock.calls[5]?.[0].idempotencyKey).not.toBe(
    dispatch.mock.calls[4]?.[0].idempotencyKey,
  );
});

describe("pluginWebhookStatusText", () => {
  const webhook = {
    id: "subscription",
    name: "incoming",
    failure: null,
    account: "account",
    createdAt: null,
  } as const;
  it("says a disabled webhook waits for its removal at the service, and why", () => {
    expect(pluginWebhookStatusText({ ...webhook, status: "disabled" })).toBe(
      "Waiting for you to remove it at the service: Opensteer can't remove it there itself",
    );
    expect(pluginWebhookStatusText({ ...webhook, status: "stopped" })).toBe("Stopped");
  });
});
