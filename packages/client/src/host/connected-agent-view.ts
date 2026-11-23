import { workWords } from "./agent-work-copy.js";
import { activityRows } from "./agent-work.js";
import {
  BrowserProfileIdSchema,
  agentGrantPluginTargetKey,
  chatGrantRefusal,
  type ChatGrantShape,
  agentGrantResourceKey,
  type AgentGrant,
  type AgentGrantResource,
  type AgentOperationView,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import { accessModeOptions } from "./access-modes.js";
import { agentWho, agentWithdrawnLine, type AgentWho } from "./agent-identity.js";
import type { ThreadSummary } from "./client.js";
import { agentWords } from "./connected-agents-copy.js";
import { chatFacts } from "./chat-view.js";
import { formatRelativeTime } from "./thread-list-model.js";

/**
 * Where a connection stands as the person reads it. `revoked` is this client's own fact
 * between the Home confirming a Disconnect and the next list read, which then says
 * `stopping` or `stopped`. `paused` is a chat that holds what it is sent until it is back.
 * `unknown` is a state this client does not know: never shown as active, never taken as ended.
 */
export type ConnectedAgentPhase =
  "active" | "paused" | "unknown" | "revoked" | "stopping" | "stopped" | "expired";

/** The states that prove a connection ended: only these confirm a Disconnect. */
export function connectionStateEnded(state: string | undefined): boolean {
  return state === "revoked" || state === "stopping" || state === "stopped" || state === "expired";
}
export type ConnectedAgentTone = "neutral" | "good" | "attention" | "bad";

/** What the Home proved about who is asking, beside the name it gave itself. */
export interface ConnectedAgentIdentity {
  readonly label: string;
  /** Self-asserted by the client. */
  readonly clientName: string;
  /** The consented redirect's host, or null when the Home proves none. */
  readonly origin: string | null;
  readonly local: boolean;
  /** A provider logo, only for a platform the Home verified; never guessed from a domain. */
  readonly providerId: string | null;
  readonly initial: string;
  /** Who it is, in the Home's words where the Home said. */
  readonly who: AgentWho;
}

export interface ConnectedAgentRow {
  readonly id: string;
  readonly identity: ConnectedAgentIdentity;
  readonly phase: ConnectedAgentPhase;
  readonly uncertain: boolean;
  /** The one line under its name. */
  readonly line: string;
  readonly tone: ConnectedAgentTone;
  /** It has ended, so it may come off the list. */
  readonly removable: boolean;
  readonly connection: AgentConnection;
}

export interface ConnectedAgentsView {
  readonly connected: readonly ConnectedAgentRow[];
  readonly disconnected: readonly ConnectedAgentRow[];
}

export interface ConnectedAgentStatus {
  readonly label: string;
  readonly detail: string;
  readonly tone: ConnectedAgentTone;
  readonly steps: readonly {
    readonly label: string;
    readonly state: "done" | "current" | "pending";
  }[];
}

export interface ConnectedAgentLive {
  readonly what: string;
  readonly threadId: string;
}

type ConnectedAgentTask = {
  readonly thread: Pick<ThreadSummary, "id" | "title" | "status" | "externalWork">;
};

export function connectedAgentWorkingTasks(
  connectionId: string,
  tasks: readonly ConnectedAgentTask[],
) {
  return tasks.filter(
    ({ thread }) =>
      thread.status === "running" &&
      thread.externalWork?.status === "active" &&
      thread.externalWork.connection.id === connectionId,
  );
}

export function connectedAgentLive(
  tasks: readonly ConnectedAgentTask[],
  operations: readonly Pick<AgentOperationView, "taskId" | "sessionId">[] = [],
): ConnectedAgentLive | null {
  const byId = new Map(tasks.map(({ thread }) => [thread.id, thread]));
  for (const operation of operations) {
    const thread = byId.get(operation.taskId);
    if (thread?.externalWork?.sessionId === operation.sessionId) {
      return { what: thread.title, threadId: thread.id };
    }
  }
  const thread = tasks[0]?.thread;
  return thread ? { what: thread.title, threadId: thread.id } : null;
}

/** One finished or refused operation, for Recent activity once the Home lists them. */
export interface ConnectedAgentActivityItem {
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly tone: "ok" | "bad" | "warn" | "muted";
  readonly at: string;
}
export type ConnectedAgentActivity =
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly items: readonly ConnectedAgentActivityItem[] };

/** A connection's Recent activity from a page of `connections.activity`: one ordered list. */
export function connectedAgentActivity(
  page: Parameters<typeof activityRows>[0],
): ConnectedAgentActivity {
  return {
    kind: "ready",
    items: activityRows(page).map((row) => ({
      id: row.id,
      action: row.action,
      outcome: row.outcome.label,
      tone: row.outcome.tone === "busy" ? "muted" : row.outcome.tone,
      at: row.at,
    })),
  };
}

export interface ConnectedAgentDetail {
  readonly row: ConnectedAgentRow;
  readonly status: ConnectedAgentStatus;
  /** The separate fact that contact was lost mid-action, with what to do about it. */
  readonly uncertain: { readonly label: string; readonly detail: string } | null;
  /** The Home stores no grant for it: an older Home, where it can do everything. */
  readonly legacy: boolean;
  readonly editable: boolean;
  readonly grant: AgentGrant;
  readonly revision: number;
  readonly accessMode: ThreadAccessMode;
  readonly live: ConnectedAgentLive | null;
  readonly activity: ConnectedAgentActivity;
  readonly about: readonly { readonly label: string; readonly value: string }[];
}

/** Names this client can put to granted things without reading anything more. */
export interface GrantNames {
  readonly profiles: readonly { readonly id: string; readonly name: string }[];
}

export function connectedAgentIdentity(
  source: Pick<AgentConnection, "label" | "clientName"> &
    Partial<
      Pick<AgentConnection, "client" | "identity" | "identityAtConsent" | "verificationWithdrawnAt">
    >,
  redirectUri?: string,
  withdrawnAt?: string | null,
): ConnectedAgentIdentity {
  const redirect = redirectUri ?? source.client?.redirectOrigin ?? null;
  const who = agentWho({
    clientName: source.clientName,
    redirect,
    identity: source.identity,
    identityAtConsent: source.identityAtConsent,
    withdrawnAt: source.verificationWithdrawnAt ?? withdrawnAt,
  });
  const label = who.providerId ? who.heading : source.label;
  const initial = Array.from(label.trim() || source.clientName)[0]?.toUpperCase() ?? "?";
  return {
    label,
    clientName: source.clientName,
    origin: hostOf(redirect),
    local: who.local,
    providerId: who.providerId,
    initial,
    who,
  };
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

export function connectedAgentPhase(
  connection: AgentConnection,
  revoked: ReadonlySet<string> = new Set(),
  now = new Date(),
): ConnectedAgentPhase {
  // Read as a plain string: a Home newer than this client may say what it does not know.
  const state: string | undefined = connection.state;
  if (state === "stopping" || state === "stopped" || state === "expired") return state;
  if (state === "revoked" || revoked.has(connection.id)) return "revoked";
  if (connection.revokedAt) return "revoked";
  if (state === "paused") return "paused";
  if (state !== undefined && state !== "active") return "unknown";
  return connection.expiresAt !== null && Date.parse(connection.expiresAt) <= now.getTime()
    ? "expired"
    : "active";
}

/** Still connected, as far as the person can tell: it may act, or will once it is back. */
export function connectedAgentConnected(phase: ConnectedAgentPhase): boolean {
  return phase === "active" || phase === "paused" || phase === "unknown";
}

/** A connection with no stored grant is one an older Home lets do everything. */
export function connectionGrant(connection: Pick<AgentConnection, "grant">): AgentGrant {
  return connection.grant ?? { scope: "everything" };
}

/** What a grant reaches, in a few words: names where this client knows them, counts elsewhere. */
export function grantSummaryParts(grant: AgentGrant, names: GrantNames): readonly string[] {
  if (grant.scope === "everything") return [agentWords("agents.row.everything")];
  const parts: string[] = [];
  const profiles = grant.resources.filter((resource) => resource.kind === "browser-profile");
  for (const resource of profiles) {
    const name = names.profiles.find(({ id }) => id === resource.profileId)?.name;
    parts.push(
      name
        ? agentWords("agents.row.profile", { profile: name })
        : agentWords("agents.row.someProfile"),
    );
  }
  if (grant.resources.some((resource) => resource.kind === "chrome-tabs"))
    parts.push(agentWords("agents.row.chromeTabs"));
  const apps = grant.resources.filter((resource) => resource.kind === "computer-app").length;
  if (apps)
    parts.push(
      apps === 1 ? agentWords("agents.row.app") : agentWords("agents.row.apps", { count: apps }),
    );
  const plugins = grant.resources.filter((resource) => resource.kind === "plugin").length;
  if (plugins)
    parts.push(
      plugins === 1
        ? agentWords("agents.row.plugin")
        : agentWords("agents.row.plugins", { count: plugins }),
    );
  if (grant.tasks) parts.push(agentWords("agents.row.tasks"));
  return parts;
}

export function grantSummary(grant: AgentGrant, names: GrantNames): string {
  const parts = grantSummaryParts(grant, names);
  if (parts.length === 0) return agentWords("agents.row.nothing");
  if (parts.length <= 2) return parts.join(" · ");
  return `${parts.slice(0, 2).join(" · ")} · ${agentWords("agents.row.more", { count: parts.length - 2 })}`;
}

function modeLabel(mode: ThreadAccessMode): string {
  return accessModeOptions.find((option) => option.mode === mode)?.label ?? mode;
}

function rowLine(
  connection: AgentConnection,
  phase: ConnectedAgentPhase,
  names: GrantNames,
): { readonly line: string; readonly tone: ConnectedAgentTone } {
  if (phase === "active" || phase === "revoked") {
    if (phase === "revoked") return { line: agentWords("agents.row.stopping"), tone: "neutral" };
    const summary = agentWords("agents.row.summary", {
      summary: grantSummary(connectionGrant(connection), names),
      mode: modeLabel(connection.accessMode),
    });
    // A chat says where it listens first, beside what it can use like any connected agent.
    const where = connection.bridge ? chatFacts(connection, phase)?.where : undefined;
    return {
      line: where ? agentWords("chat.row", { where, summary }) : summary,
      tone: "neutral",
    };
  }
  if (phase === "paused") return { line: agentWords("agents.row.paused"), tone: "attention" };
  if (phase === "unknown") return { line: agentWords("agents.row.unknown"), tone: "attention" };
  if (connection.lastActionUncertain)
    return { line: agentWords("agents.row.uncertain"), tone: "attention" };
  if (phase === "stopping") return { line: agentWords("agents.row.stopping"), tone: "neutral" };
  if (phase === "expired") return { line: agentWords("agents.row.expired"), tone: "neutral" };
  return { line: agentWords("agents.row.stopped"), tone: "neutral" };
}

export function connectedAgentRow(
  connection: AgentConnection,
  names: GrantNames,
  revoked: ReadonlySet<string> = new Set(),
  now = new Date(),
  /** When the Home withdrew this connection's verified identity, if it did. */
  withdrawnAt?: string | null,
): ConnectedAgentRow {
  const phase = connectedAgentPhase(connection, revoked, now);
  const identity = connectedAgentIdentity(connection, undefined, withdrawnAt);
  const withdrawn = phase === "active" ? agentWithdrawnLine(identity.who) : null;
  const { line, tone } = withdrawn
    ? { line: `${withdrawn} ${workWords("who.withdrawnDetail")}`, tone: "attention" as const }
    : rowLine(connection, phase, names);
  return {
    id: connection.id,
    identity,
    phase,
    uncertain: connection.lastActionUncertain === true,
    line,
    tone,
    removable: phase === "stopped" || phase === "expired",
    connection,
  };
}

/** The list: who is connected now, then those whose Disconnect outcome still shows. */
export function connectedAgentsView(
  connections: readonly AgentConnection[],
  names: GrantNames,
  revoked: ReadonlySet<string> = new Set(),
  now = new Date(),
  /** By connection id: when the Home withdrew a verified identity. */
  withdrawn: Readonly<Record<string, string>> = {},
): ConnectedAgentsView {
  const rows = connections.map((connection) =>
    connectedAgentRow(connection, names, revoked, now, withdrawn[connection.id]),
  );
  return {
    connected: rows.filter((row) => connectedAgentConnected(row.phase)),
    disconnected: rows.filter((row) => !connectedAgentConnected(row.phase)),
  };
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}
function formatDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
function usedLine(lastUsedAt: string | null, now: Date): string {
  if (!lastUsedAt) return agentWords("agent.status.unused");
  const when = formatRelativeTime(lastUsedAt, now);
  return agentWords("agent.status.idleDetail", {
    time: when === "now" ? "just now" : /^\d+[mhd]$/u.test(when) ? `${when} ago` : when,
  });
}

/**
 * What a paused chat holds and what becomes of what is sent to it, in the person's words: its
 * replies wait; a message sent meanwhile arrives when it is back, or is not delivered, by what
 * its transport does; how it comes back.
 */
export function pausedDetail(connection: Pick<AgentConnection, "bridge">): string {
  const bridge = connection.bridge;
  // Each sentence only from a value the Home sent: a missing or new one says nothing it can't.
  const by = bridge?.pausedBy;
  const cause =
    by === "needs-attention"
      ? agentWords("chat.paused.attention", {
          account: bridge?.accountName ?? bridge?.provider ?? "",
        })
      : by === "you"
        ? agentWords("chat.paused.you")
        : agentWords("chat.paused.unknown");
  const sent =
    bridge?.pausedMessages === "kept"
      ? agentWords("chat.paused.kept")
      : bridge?.pausedMessages === "lost"
        ? agentWords("chat.paused.lost")
        : null;
  const next =
    by === "needs-attention"
      ? bridge?.pauseDetail
        ? agentWords("chat.paused.attentionDetail", { detail: bridge.pauseDetail })
        : agentWords("chat.paused.attentionFix")
      : by === "you"
        ? agentWords("chat.paused.resume")
        : null;
  return [cause, agentWords("chat.paused.replies"), sent, next]
    .filter((part): part is string => part !== null)
    .join(" ");
}

/** The status at the top of an agent's page. */
export function connectedAgentStatus(
  row: ConnectedAgentRow,
  now = new Date(),
  live: ConnectedAgentLive | null = null,
): ConnectedAgentStatus {
  const { connection } = row;
  const agent = row.identity.label;
  const ended = connection.revokedAt ?? null;
  switch (row.phase) {
    case "active":
      return live
        ? { label: agentWords("agent.status.working"), detail: live.what, tone: "good", steps: [] }
        : {
            label: agentWords("agent.status.idle"),
            detail: usedLine(connection.lastUsedAt, now),
            tone: "neutral",
            steps: [],
          };
    case "paused":
      return {
        label: agentWords("agent.status.paused"),
        detail: pausedDetail(connection),
        tone: "attention",
        steps: [],
      };
    case "unknown":
      return {
        label: agentWords("agent.status.unknown"),
        detail: agentWords("agent.status.unknownDetail"),
        tone: "attention",
        steps: [],
      };
    case "revoked":
      return {
        label: agentWords("disconnect.revoked.label", { agent }),
        detail: agentWords("disconnect.revoked.detail", {
          time: formatClock(ended ?? now.toISOString()),
        }),
        tone: "neutral",
        steps: [
          { label: agentWords("disconnect.step.removed"), state: "done" },
          { label: agentWords("disconnect.step.stopping"), state: "current" },
          { label: agentWords("disconnect.step.stopped"), state: "pending" },
        ],
      };
    case "stopping":
      return {
        label: agentWords("disconnect.stopping.label"),
        detail: agentWords("disconnect.stopping.detailGeneric", { agent }),
        tone: "neutral",
        steps: [
          { label: agentWords("disconnect.step.removed"), state: "done" },
          { label: agentWords("disconnect.step.stopping"), state: "current" },
          { label: agentWords("disconnect.step.stopped"), state: "pending" },
        ],
      };
    case "stopped":
      return {
        label: agentWords("disconnect.stopped.label"),
        detail: ended
          ? agentWords("disconnect.stopped.detailRevokedAt", { time: formatClock(ended) })
          : agentWords("disconnect.stopped.label"),
        tone: "good",
        steps: [],
      };
    case "expired":
      return {
        label: agentWords("disconnect.expired.label"),
        detail: agentWords("disconnect.expired.detail", {
          time: connection.expiresAt ? `on ${formatDay(connection.expiresAt)}` : "",
          agent,
        }),
        tone: "neutral",
        steps: [],
      };
  }
}

export function connectedAgentDetail(
  connection: AgentConnection,
  names: GrantNames,
  options: {
    readonly revoked?: ReadonlySet<string>;
    readonly grantsAvailable: boolean;
    readonly live?: ConnectedAgentLive | null;
    readonly activity?: ConnectedAgentActivity;
    readonly now?: Date;
    /** When the Home withdrew this connection's verified identity, if it did. */
    readonly withdrawnAt?: string | null | undefined;
  },
): ConnectedAgentDetail {
  const now = options.now ?? new Date();
  const row = connectedAgentRow(connection, names, options.revoked, now, options.withdrawnAt);
  const legacy = !options.grantsAvailable || connection.grant === undefined;
  const identity = row.identity;
  const live = row.phase === "active" ? (options.live ?? null) : null;
  return {
    row,
    status: connectedAgentStatus(row, now, live),
    uncertain: row.uncertain
      ? {
          label: agentWords("disconnect.uncertain.label"),
          detail: agentWords("disconnect.uncertain.detailGeneric", { agent: identity.label }),
        }
      : null,
    legacy,
    editable:
      !legacy &&
      (row.phase === "active" || row.phase === "paused") &&
      connection.grantRevision !== undefined,
    grant: connectionGrant(connection),
    revision: connection.grantRevision ?? 1,
    accessMode: connection.accessMode,
    live,
    activity: options.activity ?? { kind: "unavailable" },
    // What it calls itself and the address it signed in from are facts of an agent that signed
    // in; a chat did neither, so it shows neither.
    about: [
      ...(connection.bridge
        ? []
        : [
            ...(identity.clientName !== identity.label
              ? [{ label: agentWords("agent.about.says"), value: identity.clientName }]
              : []),
            {
              label: agentWords("agent.about.origin"),
              value: identity.origin ?? agentWords("agent.about.originUnknown"),
            },
          ]),
      { label: agentWords("agent.about.connected"), value: formatDay(connection.createdAt) },
      ...(row.phase === "active" && connection.expiresAt
        ? [{ label: agentWords("agent.about.expires"), value: formatDay(connection.expiresAt) }]
        : []),
    ],
  };
}

/* ------------------------------------------------------------------------- *
 * Editing what it can use: one draft for consent and for an agent's page.
 * ------------------------------------------------------------------------- */

export interface AgentGrantDraft {
  readonly scope: "selected" | "everything";
  readonly tasks: boolean;
  /** Chosen existing resources, by `agentGrantResourceKey`. */
  readonly resources: readonly AgentGrantResource[];
  /**
   * A new dedicated profile to create before approving. `homeRunnerId` null lets the Home
   * place it (an older Home, or one with a single place for profiles).
   */
  readonly newProfile: { readonly homeRunnerId: string | null } | null;
}

/**
 * A grant as a draft. For a chat (`chat`, the shape the Home sends) Tasks is on in the draft
 * itself, whatever the scope: a chat always holds tasks, so what the editor draws and what it
 * saves are the same value, on the web and on the phone.
 */
export function draftFromGrant(grant: AgentGrant, chat?: ChatGrantShape): AgentGrantDraft {
  return grant.scope === "everything"
    ? { scope: "everything", tasks: chat !== undefined, resources: [], newProfile: null }
    : {
        scope: "selected",
        tasks: chat !== undefined || grant.tasks,
        resources: grant.resources,
        newProfile: null,
      };
}

/** Stands for a profile a draft would create; the Home's rule only reads its kind. */
const profileToCreate = "bpr_00000000-0000-4000-8000-000000000000";

/**
 * Whether the Home would refuse this draft for a chat of this shape: asked of the exact grant
 * the person is about to save, with a stand-in profile only when the draft creates one.
 */
export function chatDraftRefusal(chat: ChatGrantShape, draft: AgentGrantDraft) {
  return chatGrantRefusal(
    chat,
    grantFromDraft(
      draft,
      draft.scope === "selected" && draft.newProfile !== null ? profileToCreate : undefined,
    ),
  );
}

/** The grant a draft stands for, once any new profile exists. */
export function grantFromDraft(draft: AgentGrantDraft, createdProfileId?: string): AgentGrant {
  if (draft.scope === "everything") return { scope: "everything" };
  const resources = createdProfileId
    ? [
        ...draft.resources,
        {
          kind: "browser-profile" as const,
          profileId: BrowserProfileIdSchema.parse(createdProfileId),
        },
      ]
    : draft.resources;
  return { scope: "selected", tasks: draft.tasks, resources: canonicalResources(resources) };
}

function canonicalResources(resources: readonly AgentGrantResource[]): AgentGrantResource[] {
  const byKey = new Map<string, AgentGrantResource>();
  for (const resource of resources) byKey.set(agentGrantResourceKey(resource), resource);
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, resource]) => resource);
}

export function draftHas(draft: AgentGrantDraft, resource: AgentGrantResource): boolean {
  const key = agentGrantResourceKey(resource);
  return draft.resources.some((held) => agentGrantResourceKey(held) === key);
}

/** Adds or takes away one profile or app. */
export function toggleDraftResource(
  draft: AgentGrantDraft,
  resource: AgentGrantResource,
  on: boolean,
): AgentGrantDraft {
  const key = agentGrantResourceKey(resource);
  const rest = draft.resources.filter((held) => agentGrantResourceKey(held) !== key);
  return { ...draft, resources: on ? [...rest, resource] : rest };
}

export type PluginChoice = "off" | "read" | "read-write";

export function draftPluginAccess(
  draft: AgentGrantDraft,
  target: Extract<AgentGrantResource, { kind: "plugin" }>["target"],
): PluginChoice {
  const key = agentGrantPluginTargetKey(target);
  const held = draft.resources.find(
    (resource) => resource.kind === "plugin" && agentGrantPluginTargetKey(resource.target) === key,
  );
  return held?.kind === "plugin" ? held.access : "off";
}

export function setDraftPluginAccess(
  draft: AgentGrantDraft,
  target: Extract<AgentGrantResource, { kind: "plugin" }>["target"],
  access: PluginChoice,
): AgentGrantDraft {
  const resource: AgentGrantResource = {
    kind: "plugin",
    target,
    access: access === "off" ? "read" : access,
  };
  return toggleDraftResource(draft, resource, access !== "off");
}

/** Whether the draft lets the agent use anything at all. */
export function draftChoosesSomething(draft: AgentGrantDraft): boolean {
  return (
    draft.scope === "everything" ||
    draft.tasks ||
    draft.resources.length > 0 ||
    draft.newProfile !== null
  );
}

/** The profiles a draft shares that already hold sign-ins: each earns the honest warning. */
export function draftSharedProfiles(draft: AgentGrantDraft, names: GrantNames): readonly string[] {
  if (draft.scope !== "selected") return [];
  return draft.resources.flatMap((resource) =>
    resource.kind === "browser-profile"
      ? [
          names.profiles.find(({ id }) => id === resource.profileId)?.name ??
            agentWords("agents.row.someProfile"),
        ]
      : [],
  );
}

export function sameGrant(left: AgentGrant, right: AgentGrant): boolean {
  if (left.scope !== right.scope) return false;
  if (left.scope === "everything" || right.scope === "everything") return true;
  if (left.tasks !== right.tasks) return false;
  const keyed = (grant: Extract<AgentGrant, { scope: "selected" }>) =>
    canonicalResources(grant.resources)
      .map((resource) =>
        resource.kind === "plugin"
          ? `${agentGrantResourceKey(resource)}=${resource.access}`
          : agentGrantResourceKey(resource),
      )
      .join("|");
  return keyed(left) === keyed(right);
}
