import { createId, UserIdSchema, type AgentGrant } from "@opensteer/core";
import { hostApi, type AgentConnection, type PluginsInstalledView } from "@opensteer/protocol";
import { mockConnectedAgents } from "../mock/mock-connected-agents.js";
import { describe, expect, it } from "vitest";
import { chatFacts, messagingAccountView } from "./chat-view.js";
import { plainSentence, type SentencePart } from "./sentence-parts.js";
import {
  agentAppOptions,
  agentBrowserOptions,
  agentPluginOptions,
} from "./connected-agent-options.js";
import {
  connectedAgentDetail,
  connectedAgentPhase,
  connectedAgentRow,
  connectedAgentIdentity,
  connectedAgentLive,
  connectedAgentWorkingTasks,
  connectedAgentsView,
  draftChoosesSomething,
  draftFromGrant,
  draftPluginAccess,
  draftSharedProfiles,
  grantFromDraft,
  grantSummary,
  sameGrant,
  setDraftPluginAccess,
  toggleDraftResource,
  type AgentGrantDraft,
} from "./connected-agent-view.js";
import type { ThreadSummary } from "./client.js";
import {
  agentWords,
  anyoneChatModeDescriptions,
  connectionModeDescriptions,
  ownerChatModeDescriptions,
} from "./connected-agents-copy.js";

const now = new Date("2026-11-19T12:00:00Z");
const profile = "bpr_00000000-0000-4000-8000-000000000003";
const names = { profiles: [{ id: profile, name: "Shopping" }] };
const appApproval = "con_00000000-0000-4000-8000-0000000000aa";
const device = "dev_00000000-0000-4000-8000-0000000000d1";

function connection(patch: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "mcn_00000000-0000-4000-8000-000000000001",
    userId: UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001"),
    label: "Grok",
    clientName: "Grok",
    accessMode: "approval-required",
    grant: {
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: profile as never }],
    },
    grantRevision: 3,
    client: { fingerprint: null, redirectOrigin: "https://grok.com" },
    state: "active",
    lastActionUncertain: false,
    revokedAt: null,
    createdAt: "2026-11-02T10:00:00Z",
    lastUsedAt: "2026-11-19T10:00:00Z",
    expiresAt: "2026-12-02T10:00:00Z",
    ...patch,
  };
}

describe("connected agents list", () => {
  it("shows a paused chat as paused, with what becomes of what is sent to it, per transport and cause", () => {
    const chat = (bridge: Partial<NonNullable<AgentConnection["bridge"]>>) =>
      connection({
        label: "Slack",
        clientName: "Slack",
        state: "paused",
        expiresAt: null,
        bridge: {
          accountId: "cha_1",
          provider: "Slack",
          conversationId: null,
          senders: "owner",
          accountName: "Workshop",
          ...bridge,
        },
      });
    const slack = connectedAgentDetail(chat({ pausedBy: "you", pausedMessages: "lost" }), names, {
      grantsAvailable: true,
      now,
    });
    expect(slack.row.phase).toBe("paused");
    expect(
      connectedAgentsView([slack.row.connection], names, new Set(), now).connected,
    ).toHaveLength(1);
    expect(slack.row.line).toBe("Paused · its replies are held until it’s back");
    expect(slack.status).toMatchObject({
      label: "Paused",
      detail:
        "You paused its messaging account. Its replies are held to be sent in order when it’s back. Messages sent while this is paused are not delivered. Resume its account in Messaging to go on.",
    });
    const imessage = connectedAgentDetail(
      chat({
        provider: "iMessage",
        accountName: "tim@example.com",
        accountHandle: "tim@example.com",
        pausedBy: "needs-attention",
        pauseDetail: "Messages isn’t signed in.",
        pausedMessages: "kept",
      }),
      names,
      { grantsAvailable: true, now },
    );
    expect(imessage.status.detail).toBe(
      "Paused because tim@example.com needs attention. Its replies are held to be sent in order when it’s back. Messages sent while this is paused arrive when it’s back; one sent more than an hour before is answered that it came too late. It says: Messages isn’t signed in. Fix that on its messaging account, then check it again.",
    );
  });

  it("says nothing a paused or ended chat's Home did not say", () => {
    const chat = (bridge: Partial<NonNullable<AgentConnection["bridge"]>>, state = "paused") =>
      connection({
        label: "iMessage",
        clientName: "iMessage",
        state: state as never,
        expiresAt: null,
        revokedAt: state === "stopped" ? "2026-11-19T11:00:00Z" : null,
        bridge: {
          accountId: "cha_1",
          provider: "iMessage",
          conversationId: null,
          senders: "owner",
          accountName: "tim@example.com",
          ...bridge,
        },
      });
    // No cause and no transport fact: only that it is paused and its replies are held.
    const paused = connectedAgentDetail(chat({}), names, { grantsAvailable: true, now });
    expect(paused.status.detail).toBe(
      "This chat is paused. Its replies are held to be sent in order when it’s back.",
    );
    expect(paused.status.detail).not.toMatch(/not delivered|You paused/u);
    // No reason, or one this app doesn't know: only that it ended, and no crash.
    for (const endedBy of [undefined, "a-reason-from-a-newer-home"]) {
      const ended = connectedAgentDetail(
        chat(endedBy === undefined ? {} : { endedBy: endedBy as never }, "stopped"),
        names,
        { grantsAvailable: true, now },
      );
      expect(chatFacts(ended.row.connection, ended.row.phase)?.ended).toBe(
        "This chat has ended. To use it again, add the chat again on Messaging.",
      );
    }
  });

  it("says what an account's pause does to a message only where its provider says", () => {
    const paused = { status: "paused", statusDetail: null, transportKind: "computer" };
    expect(messagingAccountView(paused, {}).pausedNote).toBe(
      "Paused: its chats hold their replies until you resume it.",
    );
    expect(messagingAccountView(paused, { pausedMessages: "kept" }).pausedNote).toContain(
      "arrive when it’s back",
    );
    // A status this app doesn't know is said so, and offers no switch that looks on.
    expect(
      messagingAccountView({ status: "resting", statusDetail: null, transportKind: "socket" }, {}),
    ).toMatchObject({ label: "Not known to this app", canPause: false, canResume: false });
  });

  it("shows a state it does not know as unknown, never as active", () => {
    const detail = connectedAgentDetail(connection({ state: "resting" as never }), names, {
      grantsAvailable: true,
      now,
    });
    expect(detail.row.phase).toBe("unknown");
    expect(detail.status.label).toBe("Not known to this app");
    expect(detail.editable).toBe(false);
  });

  it("says what each active agent can use and its mode, in a few words", () => {
    const view = connectedAgentsView(
      [
        connection(),
        connection({
          id: "mcn_00000000-0000-4000-8000-000000000002",
          label: "Claude",
          grant: { scope: "everything" },
          accessMode: "full-access",
        }),
        connection({
          id: "mcn_00000000-0000-4000-8000-000000000003",
          label: "Trip planner",
          accessMode: "auto",
          grant: {
            scope: "selected",
            tasks: true,
            resources: [
              { kind: "browser-profile", profileId: profile as never },
              {
                kind: "computer-app",
                approvalId: appApproval,
                deviceId: device as never,
                app: { kind: "mac-app", bundleId: "com.apple.notes", teamId: null },
              },
              {
                kind: "plugin",
                access: "read",
                target: { kind: "installed", pluginId: "calendar" },
              },
            ],
          },
        }),
        connection({
          id: "mcn_00000000-0000-4000-8000-000000000004",
          grant: { scope: "selected", tasks: false, resources: [] },
        }),
      ],
      names,
      new Set(),
      now,
    );
    expect(view.connected.map((row) => row.line)).toEqual([
      "Shopping profile · Supervised",
      "Everything · Full access",
      "Shopping profile · 1 app · +2 · Auto",
      "Nothing chosen · Supervised",
    ]);
    expect(view.disconnected).toEqual([]);
  });

  it("moves a disconnected agent below with its honest outcome", () => {
    const view = connectedAgentsView(
      [
        connection(),
        connection({
          id: "mcn_00000000-0000-4000-8000-000000000002",
          state: "stopping",
          revokedAt: "2026-11-19T11:00:00Z",
        }),
        connection({
          id: "mcn_00000000-0000-4000-8000-000000000003",
          state: "stopped",
          revokedAt: "2026-11-19T11:00:00Z",
        }),
        connection({
          id: "mcn_00000000-0000-4000-8000-000000000004",
          state: "stopping",
          lastActionUncertain: true,
        }),
        connection({ id: "mcn_00000000-0000-4000-8000-000000000005", state: "expired" }),
      ],
      names,
      new Set(["mcn_00000000-0000-4000-8000-000000000001"]),
      now,
    );
    expect(view.connected).toEqual([]);
    expect(view.disconnected.map((row) => [row.phase, row.line, row.removable])).toEqual([
      ["revoked", "Stopping…", false],
      ["stopping", "Stopping…", false],
      ["stopped", "Disconnected", true],
      ["stopping", "Check its last action", false],
      ["expired", "Expired", true],
    ]);
  });

  it("treats a connection an older Home lists without a grant as everything", () => {
    const { grant: _grant, grantRevision: _revision, state: _state, ...old } = connection();
    const [row] = connectedAgentsView([old], names, new Set(), now).connected;
    expect(row!.line).toBe("Everything · Supervised");
    const detail = connectedAgentDetail(old, names, { grantsAvailable: false, now });
    expect(detail.legacy).toBe(true);
    expect(detail.editable).toBe(false);
  });
});

describe("connected agent identity", () => {
  it("shows a provider mark only for a platform the Home verified, never for a domain or a name", () => {
    // A redirect domain proves nothing on its own: without the Home's report, no mark.
    expect(
      connectedAgentIdentity(
        connection({ client: { fingerprint: null, redirectOrigin: "https://chatgpt.com" } }),
      ).providerId,
    ).toBeNull();
    expect(
      connectedAgentIdentity(
        connection({
          client: { fingerprint: null, redirectOrigin: "https://chatgpt.com" },
          identityAtConsent: {
            kind: "platform",
            platformOrigin: "https://chatgpt.com",
            platformDirectoryId: "chatgpt",
            platformName: "ChatGPT",
            directoryRevision: 1,
            recordedAt: "2026-11-03T10:00:00.000Z",
          },
          identity: {
            evidenceKind: "platform",
            verified: true,
            selfAsserted: false,
            heading: "ChatGPT",
            detail: "https://chatgpt.com",
            origins: [],
            warning: "Only allow this if you started it yourself.",
          },
        }),
      ).providerId,
    ).toBe("openai");
    expect(
      connectedAgentIdentity(
        connection({
          clientName: "ChatGPT",
          label: "ChatGPT",
          client: { fingerprint: null, redirectOrigin: "https://evil.example" },
        }),
      ).providerId,
    ).toBeNull();
    expect(
      connectedAgentIdentity(
        connection({ client: { fingerprint: null, redirectOrigin: "http://127.0.0.1:4999" } }),
      ),
    ).toMatchObject({ local: true, providerId: null });
    expect(connectedAgentIdentity(connection({ client: undefined })).origin).toBeNull();
  });

  it("shows withdrawal from the Home's connection read with the recorded name", () => {
    const withdrawn = connection({
      verificationWithdrawnAt: "2026-11-03T11:00:00.000Z",
      identity: {
        evidenceKind: "platform",
        verified: true,
        selfAsserted: false,
        heading: "ChatGPT",
        detail: "https://chatgpt.com",
        origins: [],
        warning: "Only allow this if you started it yourself.",
      },
    });
    expect(connectedAgentIdentity(withdrawn).who).toMatchObject({
      heading: "ChatGPT",
      verified: false,
      withdrawnSince: withdrawn.verificationWithdrawnAt,
    });
  });
});

describe("connected agent detail", () => {
  it("shows the current task and ignores operations from past sessions or other connections", () => {
    const agent = connection();
    const sessionId = createId("agentSession");
    const otherSessionId = createId("agentSession");
    const task = (
      title: string,
      work: NonNullable<ThreadSummary["externalWork"]>,
      status: ThreadSummary["status"] = "running",
    ) => ({
      thread: { id: createId("thread"), title, status, externalWork: work },
    });
    const work = { sessionId, connection: agent, status: "active", endReason: null } as const;
    const first = task("Prepare the itinerary", work);
    const current = task("Check the booking", { ...work, sessionId: otherSessionId });
    const waiting = task("Wait for approval", work, "waiting");
    const ended = task("Finished work", { ...work, status: "ended", endReason: "stopped" });
    const other = task("Someone else’s task", {
      ...work,
      connection: { ...agent, id: `${agent.id}-other` },
    });
    const tasks = connectedAgentWorkingTasks(agent.id, [waiting, ended, other, first, current]);
    expect(tasks).toEqual([first, current]);
    const live = connectedAgentLive(tasks, [
      { taskId: other.thread.id, sessionId },
      { taskId: first.thread.id, sessionId: createId("agentSession") },
      { taskId: current.thread.id, sessionId: otherSessionId },
    ]);
    expect(live).toEqual({ what: "Check the booking", threadId: current.thread.id });
    expect(connectedAgentDetail(agent, names, { grantsAvailable: true, now, live }).status).toEqual(
      {
        label: "Working now",
        detail: "Check the booking",
        tone: "good",
        steps: [],
      },
    );
    expect(
      connectedAgentDetail(agent, names, {
        grantsAvailable: true,
        now,
        live,
        revoked: new Set([agent.id]),
      }).live,
    ).toBeNull();
    expect(
      connectedAgentLive(connectedAgentWorkingTasks(agent.id, [waiting, ended, other])),
    ).toBeNull();
  });

  it("is idle and editable while active", () => {
    const detail = connectedAgentDetail(connection(), names, { grantsAvailable: true, now });
    expect(detail.status).toMatchObject({
      label: "Not doing anything",
      detail: "Last used 2h ago.",
    });
    expect(detail).toMatchObject({ editable: true, revision: 3, uncertain: null, live: null });
    expect(detail.activity).toEqual({ kind: "unavailable" });
    expect(detail.about.map((row) => row.label)).toEqual(["Address it uses", "Added", "Expires"]);
    // Where it signed in from, as the origin a person decides about.
    expect(detail.about[0]!.value).toBe("https://grok.com");
    expect(detail.about[0]!.valueParts).toEqual([{ address: "https://grok.com" }]);
  });

  it("names the self-asserted name apart from the label the person chose", () => {
    const detail = connectedAgentDetail(
      connection({ label: "Trips", clientName: "TravelBot Agent" }),
      names,
      { grantsAvailable: true, now },
    );
    // A name it chose: drawn as a name, and in quotation marks where it is plain text.
    expect(detail.about[0]).toMatchObject({
      label: "Calls itself",
      value: "“TravelBot Agent”",
      valueParts: [{ name: "TravelBot Agent" }],
    });
  });

  it("walks Revoked, Stopping and Stopped, and keeps last action uncertain a separate fact", () => {
    const revoked = connectedAgentDetail(connection(), names, {
      grantsAvailable: true,
      revoked: new Set([connection().id]),
      now,
    });
    expect(revoked.status.label).toBe("Grok can’t do anything now");
    expect(revoked.status.steps.map((step) => step.state)).toEqual(["done", "current", "pending"]);
    expect(revoked.editable).toBe(false);

    const stopping = connectedAgentDetail(
      connection({ state: "stopping", revokedAt: "2026-11-19T11:00:00Z" }),
      names,
      { grantsAvailable: true, now },
    );
    expect(stopping.status.label).toBe("Stopping its work");
    expect(stopping.status.detail).toContain("Grok already can’t use anything");

    const stopped = connectedAgentDetail(
      connection({ state: "stopped", revokedAt: "2026-11-19T11:00:00Z" }),
      names,
      { grantsAvailable: true, now },
    );
    expect(stopped.status).toMatchObject({ label: "Disconnected", tone: "good" });
    expect(stopped.row.removable).toBe(true);
    expect(stopped.uncertain).toBeNull();

    const uncertain = connectedAgentDetail(
      connection({
        state: "stopped",
        lastActionUncertain: true,
        revokedAt: "2026-11-19T11:00:00Z",
      }),
      names,
      { grantsAvailable: true, now },
    );
    expect(uncertain.status.label).toBe("Disconnected");
    expect(uncertain.uncertain?.label).toBe("Check its last action");

    const expired = connectedAgentDetail(connection({ state: "expired" }), names, {
      grantsAvailable: true,
      now,
    });
    expect(expired.status.label).toBe("Expired");
    expect(expired.status.detail).toContain("Connect it again from Grok");
  });
});

describe("grant drafts", () => {
  const empty: AgentGrantDraft = {
    scope: "selected",
    tasks: false,
    resources: [],
    newProfile: null,
  };
  it("turns choices into exactly one canonical grant", () => {
    let draft = toggleDraftResource(
      empty,
      { kind: "browser-profile", profileId: profile as never },
      true,
    );
    draft = setDraftPluginAccess(draft, { kind: "installed", pluginId: "calendar" }, "read-write");
    draft = setDraftPluginAccess(draft, { kind: "installed", pluginId: "calendar" }, "read");
    expect(draftPluginAccess(draft, { kind: "installed", pluginId: "calendar" })).toBe("read");
    draft = { ...draft, tasks: true, newProfile: { homeRunnerId: null } };
    const created = "bpr_00000000-0000-4000-8000-000000000009";
    expect(grantFromDraft(draft, created)).toEqual({
      scope: "selected",
      tasks: true,
      resources: [
        { kind: "browser-profile", profileId: profile },
        { kind: "browser-profile", profileId: created },
        { kind: "plugin", access: "read", target: { kind: "installed", pluginId: "calendar" } },
      ],
    });
    draft = setDraftPluginAccess(draft, { kind: "installed", pluginId: "calendar" }, "off");
    const after = grantFromDraft(draft);
    expect(after.scope === "selected" ? after.resources : []).toHaveLength(1);
    expect(grantFromDraft({ ...draft, scope: "everything" })).toEqual({ scope: "everything" });
  });

  it("knows when nothing is chosen and which shared profiles hold sign-ins", () => {
    expect(draftChoosesSomething(empty)).toBe(false);
    expect(draftChoosesSomething({ ...empty, newProfile: { homeRunnerId: null } })).toBe(true);
    const shared = toggleDraftResource(
      empty,
      { kind: "browser-profile", profileId: profile as never },
      true,
    );
    expect(draftSharedProfiles(shared, names)).toEqual(["Shopping"]);
    expect(draftSharedProfiles({ ...shared, scope: "everything" }, names)).toEqual([]);
  });

  it("round-trips a stored grant and compares grants by content", () => {
    const grant: AgentGrant = connection().grant!;
    expect(sameGrant(grantFromDraft(draftFromGrant(grant)), grant)).toBe(true);
    expect(sameGrant(grant, { scope: "everything" })).toBe(false);
    expect(grantSummary({ scope: "selected", tasks: false, resources: [] }, names)).toBe(
      "Nothing chosen",
    );
  });
});

describe("consent option sources", () => {
  const machines = [
    {
      id: "dev_home",
      name: "Cloud Computer",
      status: "online",
      kind: "home",
      selfRunnerId: "rnr_00000000-0000-4000-8000-000000000001",
      ownership: "mine",
    },
    {
      id: device,
      name: "MacBook Pro",
      status: "offline",
      kind: "mac",
      selfRunnerId: "rnr_00000000-0000-4000-8000-000000000002",
      ownership: "mine",
    },
    {
      id: "dev_00000000-0000-4000-8000-0000000000d2",
      name: "iPhone",
      status: "online",
      kind: "phone",
      phoneDisplay: {
        definitionId: "iphone-screen",
        setup: {
          location: "driver-mac",
          driverRunnerId: "rnr_00000000-0000-4000-8000-000000000002",
          driverRunnerName: "MacBook Pro",
        },
      },
    },
  ] as never;

  it("never offers the AI engine sign-in profile to an agent", () => {
    const options = agentBrowserOptions({
      browserProfiles: [
        { id: profile, name: "Shopping", homeRunnerId: null },
        {
          id: "bpr_00000000-0000-4000-8000-000000000005",
          name: "AI engine sign-in",
          homeRunnerId: null,
          purpose: "engine-sign-in",
        },
      ],
      browserProfileHomes: [],
      machines,
    });
    expect(options.profiles.map((option) => option.id)).toEqual([profile]);
  });

  it("lists profiles with their Device and where a new profile can live", () => {
    const options = agentBrowserOptions({
      browserProfiles: [
        { id: profile, name: "Shopping", homeRunnerId: "rnr_00000000-0000-4000-8000-000000000002" },
        { id: "bpr_00000000-0000-4000-8000-000000000004", name: "Fresh", homeRunnerId: null },
      ],
      browserProfileHomes: [
        "rnr_00000000-0000-4000-8000-000000000002",
        "rnr_00000000-0000-4000-8000-000000000001",
      ],
      machines,
    });
    expect(options.profiles.map((option) => option.detail)).toEqual([
      "MacBook Pro · Offline",
      "Not opened on a device yet",
    ]);
    expect(options.homes?.map((home) => home.name)).toEqual(["Cloud Computer", "MacBook Pro"]);
    expect(options.defaultHome).toBe("rnr_00000000-0000-4000-8000-000000000001");
    expect(agentBrowserOptions({ browserProfiles: [], machines }).homes).toBeNull();
    expect(
      agentBrowserOptions({ browserProfiles: [], browserProfileHomes: [], machines }).homes,
    ).toEqual([]);
  });

  it("states approved apps and phone screens exactly, and leaves out what it can't", () => {
    const options = agentAppOptions(
      [
        {
          connectionId: appApproval,
          machineId: device,
          name: "Notes",
          iconPng: null,
          target: {
            kind: "app",
            app: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
          },
        },
        {
          connectionId: "con_00000000-0000-4000-8000-0000000000ab",
          machineId: "dev_00000000-0000-4000-8000-0000000000d2",
          name: "iPhone Screen",
          iconPng: null,
          target: { kind: "phone", display: "main" },
        },
        {
          connectionId: "con_00000000-0000-4000-8000-0000000000ac",
          machineId: "dev_00000000-0000-4000-8000-0000000000ff",
          name: "Gone phone",
          iconPng: null,
          target: { kind: "phone", display: "main" },
        },
      ] as never,
      machines,
    );
    expect(options.map((option) => [option.name, option.detail, option.resource.app])).toEqual([
      ["Notes", "MacBook Pro", { kind: "mac-app", bundleId: "com.apple.notes", teamId: null }],
      [
        "iPhone Screen",
        "through MacBook Pro",
        { kind: "phone-screen", definitionId: "iphone-screen" },
      ],
    ]);
  });

  it("offers only plugins agents may use, writable only where their owner allows it", () => {
    const view = {
      engine: { state: "ready" },
      cursor: "next",
      plugins: [
        { id: "calendar", name: "Calendar", access: "all" },
        { id: "docs", name: "Docs", access: "read-only" },
        { id: "off", name: "Off plugin", access: "off" },
      ],
      local: [
        {
          id: "app_device_con_00000000-0000-4000-8000-0000000000c1",
          kind: "device-app",
          title: "Contacts",
          computer: { id: "x", name: "iPhone" },
          access: "all",
          toolCount: 2,
          readOnlyToolCount: 2,
        },
        {
          id: "app_server_isv_00000000-0000-4000-8000-0000000000e1",
          kind: "local-server",
          title: "DNS server",
          computer: { id: "y", name: "MacBook Pro" },
          access: "all",
          toolCount: 3,
          readOnlyToolCount: 1,
        },
      ],
    } as unknown as PluginsInstalledView;
    const { options, more } = agentPluginOptions(view);
    expect(more).toBe(true);
    expect(options.map((option) => [option.name, option.writable, option.target.kind])).toEqual([
      ["Calendar", true, "installed"],
      ["Docs", false, "installed"],
      ["Contacts", false, "device-account"],
      ["DNS server", true, "local-server"],
    ]);
  });
});

describe("connected agents copy", () => {
  it("fills values and keeps the safety mode lines for connections", () => {
    expect(agentWords("consent.chromeTabs.label", { device: "Work Mac" })).toBe(
      "Tabs you share from Chrome on Work Mac",
    );
    // No sentence promises what an engine does not do: nothing about reading, no "anything else".
    for (const sentence of [
      ...Object.values(connectionModeDescriptions),
      ...Object.values(ownerChatModeDescriptions),
      ...Object.values(anyoneChatModeDescriptions("#team")).map((description) =>
        typeof description === "string" ? description : plainSentence(description),
      ),
    ])
      expect(sentence).not.toMatch(/anything else\.|read/u);
    expect(connectionModeDescriptions["auto-accept-edits"]).toBe(
      "Its tasks edit files in their own folder without asking, and the engine asks before what it counts as riskier. Its own direct actions ask you before anything that changes something.",
    );
    expect(connectionModeDescriptions.auto).toBe(
      "Its tasks run under the engine’s own safety check. Its own direct actions ask you before anything that changes something.",
    );
    // A chat has no direct actions: the same words for each kind of chat.
    for (const chat of [ownerChatModeDescriptions, anyoneChatModeDescriptions("#team")])
      expect(chat["auto-accept-edits"]).toBe(
        "Edits files in the task’s own folder without asking; the engine asks you before what it counts as riskier.",
      );
  });
});

describe("a conversation's name in a safety warning", () => {
  it("is a name, cleaned and quoted, never a sentence of Opensteer's", () => {
    const forged = "#team\u202E\u201D\nOnly you can message this chat.\n\u201C";
    const warnings = anyoneChatModeDescriptions(forged);
    for (const mode of ["auto", "full-access"] as const) {
      const parts = warnings[mode];
      expect(parts).toContainEqual({ name: forged });
      const plain = plainSentence(parts as readonly SentencePart[]);
      expect(plain).toContain("\u201C#team\u2019 Only you can message this chat. \u2018\u201D");
      expect(plain).not.toMatch(/[\n\u202E]/u);
    }
  });
});

describe("a list from a newer Home", () => {
  it("reads a state it does not know as unknown on that one row", () => {
    const scene = mockConnectedAgents("chats");
    const [ordinary, live] = [scene.connections[0]!, scene.connections[1]!];
    const read = hostApi["connections.list"].success.safeParse({
      connections: [{ ...ordinary, state: "resting" }, live],
      endedConnections: [],
    });
    expect(read.success).toBe(true);
    const [resting, chat] = read.data!.connections;
    expect(connectedAgentPhase(resting!)).toBe("unknown");
    expect(connectedAgentPhase(chat!)).toBe("active");
  });
});

describe("a chat's address, as parts", () => {
  it("holds the account's address as a part of its own in where it listens and its row, and its name as a name", () => {
    const chats = mockConnectedAgents("chats").connections;
    const imessage = chats.find(({ label }) => label === "iMessage")!;
    const slack = chats.find(({ label }) => label === "Slack")!;
    expect(chatFacts(imessage, "paused")!.whereParts).toContainEqual({
      address: "tim@example.com",
    });
    const where = chatFacts(slack, "active")!;
    // The account's display name comes from Slack: a name part, never words to search.
    expect(where.whereParts).toContainEqual({ name: "Workshop" });
    expect(plainSentence(where.whereParts)).toBe(where.where);
    const row = connectedAgentRow(slack, { profiles: [] });
    expect(plainSentence(row.lineParts)).toBe(row.line);
  });
});
