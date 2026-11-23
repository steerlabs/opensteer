import { whoLines } from "../thread/agent-session-model.js";
import { failureWords } from "../ui/client-feedback.js";
import {
  agentBrowserOptions,
  agentHomeName,
  agentWords,
  workWords,
  chatFacts,
  connectedAgentConnected,
  connectionsRead,
  connectedAgentDetail,
  chatScreenHost,
  createDedicatedProfile,
  chatDraftRefusal,
  draftFromGrant,
  grantFromDraft,
  agentWhoOriginLine,
  toggleDraftResource,
  sameGrant,
  type AgentGrantDraft,
  type ConnectedAgentDetail,
  type HostClient,
} from "@opensteer/client/host";
import {
  useAgentAppOptions,
  useAgentPluginOptions,
  useChromeTabGrantCatalog,
  useConnectedAgentLive,
  useConnectedAgents,
} from "@opensteer/client/react";
import { type ChatGrantShape, type ThreadAccessMode } from "@opensteer/core";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useState, type ReactNode } from "react";
import { Alert } from "react-native";
import {
  agentGrantSections,
  agentModeSection,
  type AgentGrantContext,
  type AgentGrantSheet,
} from "./agent-grant-sections.js";
import { AgentGrantSheetPage } from "./agent-grant-sheet.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";

type Props = StaticScreenProps<{ readonly deploymentId: string; readonly connectionId: string }>;

export function ConnectedAgentScreen({ route }: Props): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <ConnectedAgentController
      connectionId={route.params.connectionId}
      deploymentId={route.params.deploymentId}
      host={host}
    />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

/**
 * One connected agent. Each change saves as it is made, against the revision it was
 * made on; a list opened as a sheet saves when the sheet closes.
 */
export function ConnectedAgentController(props: {
  readonly connectionId: string;
  readonly deploymentId: string;
  readonly host: HostClient;
}): ReactNode {
  const { host, connectionId, deploymentId } = props;
  const navigation = useNavigation();
  const agents = useConnectedAgents(host);
  // What this screen sends is what the chat parity script covers.
  const chatHost = chatScreenHost(host);
  const live = useConnectedAgentLive(host, connectionId);
  const chromeTabs = useChromeTabGrantCatalog(host, true);
  const [sheet, setSheet] = useState<{
    readonly which: AgentGrantSheet;
    readonly draft: AgentGrantDraft;
  } | null>(null);
  const [note, setNote] = useState<"saved" | "profile-failed" | null>(null);
  const [creating, setCreating] = useState(false);
  // The task whose Stop is in flight: shown as Stopping, and no second Stop is sent meanwhile.
  const [stopping, setStopping] = useState<string | null>(null);
  const connection = agents.connections?.find((row) => row.id === connectionId) ?? null;
  const snapshot = host.getSnapshot();
  const names = { profiles: snapshot.browserProfiles };
  const detail =
    connection === null
      ? null
      : connectedAgentDetail(connection, names, {
          revoked: agents.revoked,
          grantsAvailable: agents.grantsAvailable,
          live,
        });
  const agent = detail?.row.identity.label ?? null;
  useEffect(() => {
    if (agent !== null) navigation.setOptions({ title: agent });
  }, [agent, navigation]);
  const hasKind = (kind: "computer-app" | "plugin") =>
    detail?.grant.scope === "selected" &&
    detail.grant.resources.some((resource) => resource.kind === kind);
  const apps = useAgentAppOptions(host, sheet?.which === "apps" || hasKind("computer-app"));
  const plugins = useAgentPluginOptions(host, sheet?.which === "plugins" || hasKind("plugin"));

  if (detail === null || connection === null || agent === null)
    return (
      <NativeSettingsPage
        sections={[
          // Only a read answer may say it is gone: still reading, or a read that failed, says so.
          connectionsRead(agents) === "loading"
            ? {
                key: "loading",
                title: "",
                rows: [
                  { key: "placeholder", kind: "placeholder", label: agentWords("common.loading") },
                ],
              }
            : connectionsRead(agents) === "failed"
              ? {
                  key: "unreadable",
                  title: "",
                  rows: [
                    { key: "unreadable", kind: "text", label: agentWords("agent.readFailed") },
                    {
                      key: "retry",
                      kind: "button",
                      label: agentWords("common.tryAgain"),
                      onPress: () => void agents.refresh?.(),
                    },
                  ],
                }
              : {
                  key: "gone",
                  title: "",
                  rows: [{ key: "gone", kind: "text", label: agentWords("agent.notFound") }],
                },
        ]}
      />
    );

  const pending = agents.pending === connection.id ? agents.pendingAction : null;
  const busy = pending !== null || creating;
  const browser = agentBrowserOptions(snapshot);
  // What a chat's grant may hold, as the Home says; the editor offers only that.
  const chatShape = connection.bridge?.grantShape as ChatGrantShape | undefined;
  const context = {
    ...(chatShape ? { chat: chatShape } : {}),
    agent,
    home: agentHomeName(snapshot),
    chromeTabs,
    browser,
    apps,
    plugins,
    disabled: busy,
  };
  const current = draftFromGrant(detail.grant, chatShape);
  const save = async (next: {
    readonly draft?: AgentGrantDraft;
    readonly mode?: ThreadAccessMode;
  }) => {
    if (!agents.update) return;
    let draft = next.draft ?? current;
    let created: string | undefined;
    setNote(null);
    // Nothing is created for a grant the Home would refuse: asked of the Home's own rule first.
    const refusal = chatShape ? chatDraftRefusal(chatShape, draft) : null;
    if (refusal) {
      Alert.alert(agentWords("chat.grant.refused"), refusal.message);
      return;
    }
    if (draft.scope === "selected" && draft.newProfile) {
      setCreating(true);
      try {
        created = await createDedicatedProfile(chatHost, {
          name: agent,
          homeRunnerId: draft.newProfile.homeRunnerId,
        });
      } catch {
        setNote("profile-failed");
        return;
      } finally {
        setCreating(false);
      }
      draft = { ...draft, newProfile: null };
    }
    const grant = grantFromDraft(draft, created);
    const changes = {
      ...(sameGrant(grant, detail.grant) ? {} : { grant }),
      ...(next.mode === undefined || next.mode === detail.accessMode
        ? {}
        : { accessMode: next.mode }),
    };
    if (Object.keys(changes).length === 0) return;
    const result = await agents.update(connection.id, {
      expectedRevision: detail.revision,
      ...changes,
    });
    if (result.kind === "saved") setNote("saved");
  };
  const changeScope = (scope: AgentGrantDraft["scope"]) => {
    if (scope === current.scope) return;
    if (scope === "everything") {
      void save({ draft: { ...current, scope } });
      return;
    }
    Alert.alert(agentWords("agent.narrow.title", { agent }), agentWords("agent.narrow.body"), [
      { text: agentWords("common.cancel"), style: "cancel" },
      {
        text: agentWords("agent.narrow.confirm"),
        onPress: () =>
          void save({
            // A chat always holds Tasks: limiting it keeps that (the same draft function).
            draft: draftFromGrant({ scope: "selected", tasks: false, resources: [] }, chatShape),
          }),
      },
    ]);
  };
  const disconnect = () =>
    Alert.alert(
      agentWords("agent.disconnect.title", { agent }),
      agentWords("agent.disconnect.body"),
      [
        { text: agentWords("common.cancel"), style: "cancel" },
        {
          text: agentWords("agent.disconnect.confirm"),
          style: "destructive",
          onPress: () => {
            setSheet(null);
            void agents.revoke?.(connection.id);
          },
        },
      ],
    );
  // Leaves the page only once it is gone; otherwise the page says why it is not.
  const remove = () =>
    void agents.remove?.(connection.id).then((removed) => {
      if (removed) navigation.goBack();
    });
  return (
    <>
      <NativeSettingsPage
        sections={connectedAgentSections({
          busy,
          conflict: agents.conflict === connection.id,
          context,
          current,
          detail,
          error: agents.error,
          note,
          onDisconnect: disconnect,
          onMode: (mode) => void save({ mode }),
          onOpen: (which) => setSheet({ which, draft: current }),
          onRemove: remove,
          onScope: changeScope,
          onWatch: (threadId) => navigation.navigate("Thread", { deploymentId, threadId }),
          onStop: (threadId) => {
            if (stopping !== null) return;
            setStopping(threadId);
            void chatHost
              .stopRun(threadId)
              .catch((error: unknown) => {
                const words = failureWords(error, {
                  label: "stop this task",
                  done: "stopped",
                  happened: "the task was stopped",
                });
                if (words !== null) Alert.alert(agentWords("chat.tasks.stop"), words);
              })
              .finally(() => setStopping(null));
          },
          stopping,
          onChromeTab: (resource, on) =>
            void save({ draft: toggleDraftResource(current, resource, on) }),
          onTasks: (tasks) => void save({ draft: { ...current, tasks } }),
          pending,
        })}
      />
      {sheet === null ? null : (
        <AgentGrantSheetPage
          context={context}
          draft={sheet.draft}
          onChange={(draft) => setSheet({ ...sheet, draft })}
          onClose={() => {
            const edited = sheet.draft;
            setSheet(null);
            void save({ draft: edited });
          }}
          onOpenDevices={() => {
            setSheet(null);
            navigation.navigate("SettingsDevices", { deploymentId: props.deploymentId });
          }}
          sheet={sheet.which}
        />
      )}
    </>
  );
}

/** The agent's page as Settings sections: pure, so each state is checked without a screen. */
export function connectedAgentSections(props: {
  readonly busy: boolean;
  readonly conflict: boolean;
  readonly context: AgentGrantContext;
  /** Why the last action didn't finish, if it didn't. */
  readonly error: string | null;
  readonly current: AgentGrantDraft;
  readonly detail: ConnectedAgentDetail;
  readonly note: "saved" | "profile-failed" | null;
  readonly onDisconnect: () => void;
  readonly onMode: (mode: ThreadAccessMode) => void;
  readonly onOpen: (sheet: AgentGrantSheet) => void;
  readonly onRemove: () => void;
  readonly onScope: (scope: AgentGrantDraft["scope"]) => void;
  readonly onChromeTab: Parameters<typeof agentGrantSections>[0]["onChromeTab"];
  readonly onTasks: (on: boolean) => void;
  readonly onWatch: (threadId: string) => void;
  /** Stops a chat's running task; one it can't stop says why. */
  readonly onStop?: (threadId: string) => void;
  /** The task whose Stop is in flight. */
  readonly stopping?: string | null;
  readonly pending: "revoke" | "update" | "remove" | null;
}): readonly NativeSettingsSection[] {
  const { detail } = props;
  const watchThreadId = detail.live?.threadId;
  const agent = detail.row.identity.label;
  const who = whoLines(detail.row.identity.who, { consent: false });
  // Still connected (active, paused, or a state this app doesn't know): it can be disconnected.
  const active = connectedAgentConnected(detail.row.phase);
  // A chat is a connected agent with two facts of its own: where it listens, who may speak.
  const chat = chatFacts(detail.row.connection, detail.row.phase);
  const disconnectRow = (): NativeSettingsRow => ({
    key: "disconnect",
    kind: "button",
    label:
      props.pending === "revoke"
        ? agentWords("agent.disconnecting")
        : agentWords("agent.disconnect", { agent }),
    destructive: true,
    disabled: props.busy,
    onPress: props.onDisconnect,
  });
  const sections: NativeSettingsSection[] = [
    // Who it says it is, and where it signed in from: facts of an agent that signed in, never of
    // a chat.
    ...(chat
      ? []
      : [
          {
            key: "who",
            title: "",
            rows: [
              // The title is already its name: say only that it is verified, and never repeat it.
              ...(who.heading === agent && !who.verified
                ? []
                : [
                    {
                      key: "who",
                      kind: "text" as const,
                      label: who.verified
                        ? who.heading === agent
                          ? workWords("who.verified")
                          : workWords("who.verifiedAs", { name: who.heading })
                        : who.heading,
                      ...(detail.row.identity.who.origins.length ? {} : { detail: who.detail }),
                    },
                  ]),
              ...detail.row.identity.who.origins.map((origin): NativeSettingsRow => ({
                key: origin.role,
                kind: "text",
                label: agentWhoOriginLine(origin),
              })),
            ],
          },
        ]),
    // Opensteer stopped vouching for it: said once, with the one way to act on it.
    ...(who.withdrawn !== null && active
      ? [
          {
            key: "withdrawn",
            title: "",
            rows: [
              {
                key: "withdrawn",
                kind: "status" as const,
                tone: "attention" as const,
                label: who.withdrawn.line,
              },
              disconnectRow(),
            ],
            footer: { text: who.withdrawn.detail },
          },
        ]
      : []),
    {
      key: "status",
      title: "",
      rows: [
        {
          key: "status",
          kind: "status",
          tone: detail.status.tone,
          label: detail.status.label,
          ...(detail.status.steps.length ? { steps: detail.status.steps } : {}),
        },
        ...(watchThreadId
          ? [
              {
                key: "watch",
                kind: "button" as const,
                label: agentWords("agent.watch"),
                symbol: "eye" as const,
                opens: true,
                onPress: () => props.onWatch(watchThreadId),
              },
            ]
          : []),
      ],
      footer: { text: detail.status.detail },
    },
    // An edit that met a newer one says so on its own: what the status says (a paused chat's
    // held replies) stays.
    ...(props.conflict
      ? [{ key: "conflict", title: "", rows: [], footer: { text: agentWords("agent.conflict") } }]
      : []),
  ];
  if (chat) {
    if (chat.ended)
      sections.push({
        key: "chat-ended",
        title: "",
        rows: [{ key: "ended", kind: "text", label: chat.ended }],
      });
    if (chat.unknownReplies)
      sections.push({
        key: "chat-unknown",
        title: "",
        rows: [{ key: "unknown", kind: "status", tone: "attention", label: chat.unknownReplies }],
      });
    sections.push(
      {
        key: "chat-where",
        title: agentWords("chat.where.title"),
        rows: [{ key: "where", kind: "text", label: chat.where }],
      },
      {
        key: "chat-speakers",
        title: agentWords("chat.speakers.title"),
        rows: [
          {
            key: "speakers",
            kind: "text",
            label: chat.speakers.title,
            detail: chat.speakers.detail,
          },
        ],
        footer: { text: chat.fixed },
      },
      {
        key: "chat-tasks",
        title: agentWords("chat.tasks.title"),
        rows:
          chat.tasks.length === 0
            ? [{ key: "none", kind: "text", label: agentWords("chat.tasks.empty") }]
            : chat.tasks.flatMap((task): NativeSettingsRow[] => [
                {
                  key: task.id,
                  kind: "button",
                  label: task.title,
                  detail: agentWords(task.running ? "chat.tasks.running" : "chat.tasks.done"),
                  opens: true,
                  onPress: () => props.onWatch(task.id),
                },
                ...(active && task.running && props.onStop
                  ? [
                      {
                        key: `${task.id}-stop`,
                        kind: "button" as const,
                        label:
                          props.stopping === task.id
                            ? agentWords("chat.tasks.stopping")
                            : agentWords("chat.tasks.stop"),
                        destructive: true,
                        disabled: props.busy || (props.stopping ?? null) !== null,
                        onPress: () => props.onStop?.(task.id),
                      },
                    ]
                  : []),
              ]),
      },
    );
  }
  if (props.error !== null)
    sections.push({
      key: "error",
      title: "",
      rows: [],
      footer: { text: props.error, tone: "danger" },
    });
  if (detail.uncertain)
    sections.push({
      key: "uncertain",
      title: "",
      rows: [
        { key: "uncertain", kind: "status", tone: "attention", label: detail.uncertain.label },
      ],
      footer: { text: detail.uncertain.detail },
    });
  if (detail.legacy && detail.row.phase === "active")
    sections.push({
      key: "legacy",
      title: "",
      rows: [],
      footer: { text: agentWords("agent.legacy") },
    });
  if (detail.editable) {
    const grant = agentGrantSections({
      ...props.context,
      draft: props.current,
      mode: detail.accessMode,
      onScope: props.onScope,
      onOpen: props.onOpen,
      onChromeTab: props.onChromeTab,
      onTasks: props.onTasks,
    });
    sections.push(
      ...grant,
      agentModeSection({
        mode: detail.accessMode,
        descriptions: detail.modeDescriptions,
        disabled: props.busy,
        onMode: props.onMode,
      }),
    );
    if (props.note !== null)
      sections.push({
        key: "note",
        title: "",
        rows: [],
        footer:
          props.note === "saved"
            ? { text: agentWords("agent.saved", { agent }) }
            : { text: agentWords("consent.error.newProfile"), tone: "danger" },
      });
  }
  sections.push({
    key: "activity",
    title: agentWords("agent.activity.title"),
    rows:
      detail.activity.kind === "unavailable"
        ? [{ key: "unavailable", kind: "text", label: agentWords("agent.activity.unavailable") }]
        : detail.activity.items.length === 0
          ? [{ key: "empty", kind: "text", label: agentWords("agent.activity.empty") }]
          : detail.activity.items.map((item): NativeSettingsRow => ({
              key: item.id,
              kind: "text",
              label: item.action,
              detail: `${item.outcome} · ${item.at}`,
            })),
  });
  sections.push({
    key: "about",
    title: agentWords("agent.about.title"),
    rows: detail.about.map((row): NativeSettingsRow => ({
      key: row.label,
      kind: "text",
      label: row.label,
      detail: row.value,
    })),
  });
  if (active && who.withdrawn === null)
    sections.push({ key: "end", title: "", rows: [disconnectRow()] });
  else if (detail.row.removable)
    sections.push({
      key: "end",
      title: "",
      rows: [
        {
          key: "remove",
          kind: "button",
          label:
            props.pending === "remove"
              ? agentWords("disconnect.stopped.removing")
              : agentWords("disconnect.stopped.remove"),
          disabled: props.busy,
          onPress: props.onRemove,
        },
      ],
    });
  return sections;
}
