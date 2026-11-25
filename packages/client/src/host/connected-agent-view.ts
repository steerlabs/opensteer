import { workSentence, workWords } from "./agent-work-copy.js";
import { activityRows, connectedAgentNamePart, sessionAgent } from "./agent-work.js";
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
import {
  agentSentence,
  agentWords,
  anyoneChatModeDescriptions,
  type ConnectionModeDescription,
  connectionModeDescriptions,
  ownerChatModeDescriptions,
} from "./connected-agents-copy.js";
import { chatAccountPart, chatFacts } from "./chat-view.js";
import { plainSentence, sentenceWith, siteOrigin, type SentencePart } from "./sentence-parts.js";
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
  /** `line` as parts: a chat's address a part of its own. */
  readonly lineParts: readonly SentencePart[];
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
  readonly labelParts?: readonly SentencePart[];
  readonly detail: string;
  readonly detailParts?: readonly SentencePart[];
  readonly tone: ConnectedAgentTone;
  readonly steps: readonly {
    readonly label: string;
    readonly state: "done" | "current" | "pending";
  }[];
}

export interface ConnectedAgentLive {
  readonly what: string;
  readonly threadId: string;
  readonly state?: "working" | "needs-you";
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
  readonly uncertain: {
    readonly label: string;
    readonly detail: string;
    readonly detailParts?: readonly SentencePart[];
  } | null;
  /** The Home stores no grant for it: an older Home, where it can do everything. */
  readonly legacy: boolean;
  readonly editable: boolean;
  readonly grant: AgentGrant;
  readonly revision: number;
  readonly accessMode: ThreadAccessMode;
  /** What each safety mode means for it, where its mode is chosen (web and phone). */
  readonly modeDescriptions: Readonly<Record<ThreadAccessMode, ConnectionModeDescription>>;
  readonly live: ConnectedAgentLive | null;
  readonly activity: ConnectedAgentActivity;
  /** `valueParts`: the value as parts, an address a part of its own when it is one. */
  readonly about: readonly {
    readonly label: string;
    readonly value: string;
    readonly valueParts: readonly SentencePart[];
  }[];
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
    // Where it signed in from is a site a person decides about: its origin, parsed.
    origin: redirect === null ? null : siteOrigin(redirect),
    local: who.local,
    providerId: who.providerId,
    initial,
    who,
  };
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

/** A task can name its origin only while the owner's catalog still holds the agent. */
export function taskOriginLabels(
  connections: readonly AgentConnection[] | null,
  revoked: ReadonlySet<string>,
  now = new Date(),
): ReadonlyMap<string, readonly SentencePart[]> {
  const labels = new Map<string, readonly SentencePart[]>();
  for (const connection of connections ?? []) {
    if (
      connection.bridge ||
      !connectedAgentConnected(connectedAgentPhase(connection, revoked, now))
    )
      continue;
    labels.set(
      connection.id,
      workSentence("work.startedBy", {
        agent: connectedAgentNamePart(sessionAgent(connection, connection.verificationWithdrawnAt)),
      }),
    );
  }
  return labels;
}

/** A connection listed without a grant reads as holding nothing (this Home always sends one). */
export function connectionGrant(connection: Pick<AgentConnection, "grant">): AgentGrant {
  return connection.grant ?? { scope: "selected", tasks: false, resources: [] };
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
): {
  readonly line: string;
  readonly lineParts?: readonly SentencePart[];
  readonly tone: ConnectedAgentTone;
} {
  if (phase === "active" || phase === "revoked") {
    if (phase === "revoked") return { line: agentWords("agents.row.stopping"), tone: "neutral" };
    const summary = agentWords("agents.row.summary", {
      summary: grantSummary(connectionGrant(connection), names),
      mode: modeLabel(connection.accessMode),
    });
    // A chat says where it listens first, beside what it can use like any connected agent.
    const where = connection.bridge ? chatFacts(connection, phase)?.whereParts : undefined;
    if (!where) return { line: summary, tone: "neutral" };
    const slot = String.fromCharCode(0);
    const [before = "", after = ""] = agentWords("chat.row", { where: slot, summary }).split(slot);
    const lineParts = [before, ...where, after].filter((part) => part !== "");
    return { line: plainSentence(lineParts), lineParts, tone: "neutral" };
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
  const { line, lineParts, tone } = withdrawn
    ? {
        line: `${withdrawn} ${workWords("who.withdrawnDetail")}`,
        lineParts: undefined,
        tone: "attention" as const,
      }
    : rowLine(connection, phase, names);
  return {
    id: connection.id,
    identity,
    phase,
    uncertain: connection.lastActionUncertain === true,
    line,
    lineParts: lineParts ?? [line],
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
export function pausedDetailParts(
  connection: Pick<AgentConnection, "bridge">,
): readonly SentencePart[] {
  const bridge = connection.bridge;
  // Each sentence only from a value the Home sent: a missing or new one says nothing it can't.
  const by = bridge?.pausedBy;
  const cause: readonly SentencePart[] =
    by === "needs-attention"
      ? sentenceWith((slot) => agentWords("chat.paused.attention", { account: slot("account") }), {
          account: chatAccountPart(bridge!),
        })
      : [by === "you" ? agentWords("chat.paused.you") : agentWords("chat.paused.unknown")];
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
  const rest = [agentWords("chat.paused.replies"), sent, next]
    .filter((part): part is string => part !== null)
    .join(" ");
  return rest ? [...cause, ` ${rest}`] : cause;
}

export function pausedDetail(connection: Pick<AgentConnection, "bridge">): string {
  return plainSentence(pausedDetailParts(connection));
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
  // A chat's work is the task list its page draws (the Home's `bridge.tasks`): one source, so the
  // status never says "Not doing anything" above a task it lists as running.
  const chatWork = connection.bridge?.tasks?.find(({ running }) => running);
  const working = live ?? (chatWork ? { what: chatWork.title, threadId: chatWork.id } : null);
  const needsYou = live?.state === "needs-you";
  switch (row.phase) {
    case "active":
      return working
        ? {
            label: agentWords(needsYou ? "agent.status.needsYou" : "agent.status.working"),
            detail: working.what,
            tone: needsYou ? "attention" : "good",
            steps: [],
          }
        : {
            label: agentWords("agent.status.idle"),
            detail: usedLine(connection.lastUsedAt, now),
            tone: "neutral",
            steps: [],
          };
    case "paused": {
      const detailParts = pausedDetailParts(connection);
      return {
        label: agentWords("agent.status.paused"),
        detail: plainSentence(detailParts),
        detailParts,
        tone: "attention",
        steps: [],
      };
    }
    case "unknown":
      return {
        label: agentWords("agent.status.unknown"),
        detail: agentWords("agent.status.unknownDetail"),
        tone: "attention",
        steps: [],
      };
    case "revoked": {
      const labelParts = agentSentence("disconnect.revoked.label", { agent: { name: agent } });
      return {
        label: plainSentence(labelParts),
        labelParts,
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
    }
    case "stopping": {
      const detailParts = agentSentence("disconnect.stopping.detailGeneric", {
        agent: { name: agent },
      });
      return {
        label: agentWords("disconnect.stopping.label"),
        detail: plainSentence(detailParts),
        detailParts,
        tone: "neutral",
        steps: [
          { label: agentWords("disconnect.step.removed"), state: "done" },
          { label: agentWords("disconnect.step.stopping"), state: "current" },
          { label: agentWords("disconnect.step.stopped"), state: "pending" },
        ],
      };
    }
    case "stopped":
      return {
        label: agentWords("disconnect.stopped.label"),
        detail: ended
          ? agentWords("disconnect.stopped.detailRevokedAt", { time: formatClock(ended) })
          : agentWords("disconnect.stopped.label"),
        tone: "good",
        steps: [],
      };
    case "expired": {
      const detailParts = agentSentence(
        "disconnect.expired.detail",
        { agent: { name: agent } },
        { time: connection.expiresAt ? `on ${formatDay(connection.expiresAt)}` : "" },
      );
      return {
        label: agentWords("disconnect.expired.label"),
        detail: plainSentence(detailParts),
        detailParts,
        tone: "neutral",
        steps: [],
      };
    }
  }
}

/**
 * What the Home recorded about the last action it could not confirm, after the general
 * sentence: its reason, in the Home's own words, and the device it was on, a name the person
 * gave it and so drawn as a name.
 */
function recordedUncertainty(
  detail: AgentConnection["lastActionUncertainDetail"],
): readonly SentencePart[] {
  if (!detail) return [];
  return [
    ...(detail.reason ? [" ", detail.reason] : []),
    ...(detail.device
      ? [" ", ...agentSentence("disconnect.uncertain.device", { device: { name: detail.device } })]
      : []),
  ];
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
  const uncertainDetailParts = row.uncertain
    ? [
        ...agentSentence("disconnect.uncertain.detailGeneric", {
          agent: { name: identity.label },
        }),
        ...recordedUncertainty(connection.lastActionUncertainDetail),
      ]
    : null;
  return {
    row,
    status: connectedAgentStatus(row, now, live),
    uncertain: uncertainDetailParts
      ? {
          label: agentWords("disconnect.uncertain.label"),
          detail: plainSentence(uncertainDetailParts),
          detailParts: uncertainDetailParts,
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
    modeDescriptions:
      connection.bridge?.senders === "anyone"
        ? anyoneChatModeDescriptions(
            connection.bridge.conversationName ?? connection.bridge.conversationId ?? "",
          )
        : connection.bridge
          ? ownerChatModeDescriptions
          : connectionModeDescriptions,
    live,
    activity: options.activity ?? { kind: "unavailable" },
    // What it calls itself and the address it signed in from are facts of an agent that signed
    // in; a chat did neither, so it shows neither.
    // Each value by what it is: the name it gave itself, the origin it signed in from, a date.
    about: [
      ...(connection.bridge
        ? []
        : [
            ...(identity.clientName !== identity.label
              ? [aboutRow(agentWords("agent.about.says"), [{ name: identity.clientName }])]
              : []),
            aboutRow(agentWords("agent.about.origin"), [
              identity.origin === null
                ? agentWords("agent.about.originUnknown")
                : { address: identity.origin },
            ]),
          ]),
      aboutRow(agentWords("agent.about.connected"), [formatDay(connection.createdAt)]),
      ...(row.phase === "active" && connection.expiresAt
        ? [aboutRow(agentWords("agent.about.expires"), [formatDay(connection.expiresAt)])]
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

function aboutRow(label: string, valueParts: readonly SentencePart[]) {
  return { label, value: plainSentence(valueParts), valueParts };
}
