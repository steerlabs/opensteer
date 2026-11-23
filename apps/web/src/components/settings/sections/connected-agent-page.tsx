import { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  agentBrowserOptions,
  agentHomeName,
  agentWords,
  chatFacts,
  connectedAgentConnected,
  connectionsRead,
  connectedAgentDetail,
  createDedicatedProfile,
  chatDraftRefusal,
  draftFromGrant,
  grantFromDraft,
  sameGrant,
  type AgentGrantDraft,
  type ConnectedAgentDetail,
  type ConnectedAgentStatus,
  type HostClient,
} from "@opensteer/client/host";
import {
  useChromeTabGrantCatalog,
  useConnectedAgentActivity,
  useConnectedAgentLive,
  useConnectedAgents,
  useWorkPolicy,
} from "@opensteer/client/react";
import { type ChatGrantShape, type ThreadAccessMode } from "@opensteer/core";
import { useShell } from "../../app-shell.js";
import { Dialog } from "../../dialog.js";
import { Icon } from "../../icon.js";
import { AgentGrantEditor, ConnectionModeChoices } from "../agent-grant-editor.js";
import { AgentMark } from "../agent-mark.js";
import { AgentWhoLine, AgentWithdrawnNotice } from "../agent-who.js";
import { ChatFactsSection } from "./chat-facts.js";
import { SectionHeader, SettingsError, SettingsGroup, SettingsRow } from "../primitives.js";

interface Edit {
  readonly revision: number;
  readonly draft: AgentGrantDraft;
  readonly mode: ThreadAccessMode;
}

/**
 * One connected agent: where it stands, what it can use and how freely, what it did,
 * who it says it is beside what the Home proved, and Disconnect.
 */
export function ConnectedAgentPage({
  client,
  connectionId,
}: {
  readonly client: HostClient;
  readonly connectionId: string;
}) {
  const shell = useShell();
  const navigate = useNavigate();
  const agents = useConnectedAgents(client);
  const live = useConnectedAgentLive(client, connectionId);
  const activity = useConnectedAgentActivity(client, connectionId, live?.threadId ?? null);
  const chromeTabs = useChromeTabGrantCatalog(client, true);
  const workPolicy = useWorkPolicy(client);
  const { snapshot } = shell;
  const connection = agents.connections?.find((row) => row.id === connectionId) ?? null;
  const [edit, setEdit] = useState<Edit | null>(null);
  const [confirming, setConfirming] = useState<"disconnect" | "narrow" | null>(null);
  const [saved, setSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const back = (
    <Link className="settings-link connected-agent__back" to="..">
      <Icon name="chevron-left" />
      {agentWords("agent.back")}
    </Link>
  );
  if (!connection) {
    // Only a read answer may say it is gone: still reading, or a read that failed, says so.
    const read = connectionsRead(agents);
    if (read === "loading")
      return (
        <>
          {back}
          <p role="status">{agentWords("common.loading")}</p>
        </>
      );
    if (read === "failed")
      return (
        <>
          {back}
          <p className="notice notice--error" role="alert">
            {agentWords("agent.readFailed")}{" "}
            <button
              className="btn btn--small"
              onClick={() => void agents.refresh?.()}
              type="button"
            >
              {agentWords("common.tryAgain")}
            </button>
          </p>
        </>
      );
    return (
      <>
        {back}
        <SectionHeader title={agentWords("agent.notFound")} />
      </>
    );
  }
  const names = { profiles: snapshot.browserProfiles };
  const detail = connectedAgentDetail(connection, names, {
    revoked: agents.revoked,
    grantsAvailable: agents.grantsAvailable,
    live,
    ...(activity ? { activity } : {}),
  });
  const who = detail.row.identity.who;
  // A withdrawn verification offers Disconnect once, in its own notice.
  const withdrawn = detail.row.phase === "active" && who.withdrawnSince !== null;
  const agent = detail.row.identity.label;
  // A chat is a connected agent with two facts of its own: where it listens, who may speak.
  const chat = chatFacts(connection, detail.row.phase);
  // What a chat's grant may hold, as the Home says; the editor offers only that.
  const chatShape = connection.bridge?.grantShape as ChatGrantShape | undefined;
  const connected = connectedAgentConnected(detail.row.phase);
  // An edit belongs to the revision it was made against; a newer one shows what is set now.
  const current = edit && edit.revision === detail.revision ? edit : null;
  const draft = current?.draft ?? draftFromGrant(detail.grant, chatShape);
  const mode = current?.mode ?? detail.accessMode;
  const dirty =
    current !== null &&
    (current.mode !== detail.accessMode ||
      current.draft.newProfile !== null ||
      !sameGrant(grantFromDraft(current.draft), detail.grant));
  const pending = agents.pending === connection.id ? agents.pendingAction : null;
  const busy = pending !== null || creating;
  const browser = agentBrowserOptions(snapshot);
  const change = (next: Partial<Omit<Edit, "revision">>) => {
    setSaved(false);
    setEdit({ revision: detail.revision, draft: next.draft ?? draft, mode: next.mode ?? mode });
  };
  const save = async () => {
    if (!current || !agents.update) return;
    let draftToSave = current.draft;
    let created: string | undefined;
    // Nothing is created for a grant the Home would refuse: asked of the Home's own rule first.
    const refusal = chatShape ? chatDraftRefusal(chatShape, draftToSave) : null;
    if (refusal) {
      setProfileError(refusal.message);
      return;
    }
    if (draftToSave.scope === "selected" && draftToSave.newProfile) {
      setCreating(true);
      setProfileError(null);
      try {
        created = await createDedicatedProfile(client, {
          name: agent,
          homeRunnerId: draftToSave.newProfile.homeRunnerId,
        });
      } catch {
        setProfileError(agentWords("consent.error.newProfile"));
        return;
      } finally {
        setCreating(false);
      }
      draftToSave = { ...draftToSave, newProfile: null };
    }
    const grant = grantFromDraft(draftToSave, created);
    const result = await agents.update(connection.id, {
      expectedRevision: detail.revision,
      ...(sameGrant(grant, detail.grant) ? {} : { grant }),
      ...(current.mode === detail.accessMode ? {} : { accessMode: current.mode }),
    });
    if (result.kind === "saved") {
      setEdit(null);
      setSaved(true);
    } else if (result.kind === "conflict" || result.kind === "gone") setEdit(null);
  };
  const requestSave = () => {
    if (detail.grant.scope === "everything" && draft.scope === "selected") setConfirming("narrow");
    else void save();
  };
  return (
    <>
      {back}
      <div className="connected-agent__header">
        <AgentMark identity={detail.row.identity} large />
        <h1 className="settings-section__title">{agent}</h1>
        {detail.live?.threadId ? (
          <Link className="btn" to={`/tasks/${detail.live.threadId}`}>
            <Icon name="eye" />
            {agentWords("agent.watch")}
          </Link>
        ) : null}
      </div>
      {chat ? null : <AgentWhoLine nameShown={agent !== who.heading} who={who} />}
      <AgentWithdrawnNotice
        onDisconnect={withdrawn && !busy ? () => setConfirming("disconnect") : null}
        who={who}
      />
      <StatusNotice status={detail.status} />
      {detail.uncertain ? (
        <p className="notice connected-agent__uncertain" role="alert">
          <Icon name="alert-circle" />
          <span>
            <strong>{detail.uncertain.label}</strong>
            <br />
            {detail.uncertain.detail}
          </span>
        </p>
      ) : null}
      {agents.conflict === connection.id ? (
        <p className="notice" role="status">
          {agentWords("agent.conflict")}
        </p>
      ) : null}
      {detail.legacy && detail.row.phase === "active" ? (
        <p className="notice" role="note">
          {agentWords("agent.legacy")}
        </p>
      ) : null}
      {chat ? <ChatFactsSection client={client} facts={chat} live={connected} /> : null}
      {/* Under a work Home's ceiling, the choices wait for it: none is offered and then refused. */}
      {detail.editable && workPolicy !== undefined ? (
        <>
          <AgentGrantEditor
            chat={chatShape}
            agent={agent}
            browser={browser}
            chromeTabs={chromeTabs}
            client={client}
            disabled={busy}
            draft={draft}
            home={agentHomeName(snapshot)}
            onChange={(next) => change({ draft: next })}
            workPolicy={workPolicy ?? undefined}
          />
          <ConnectionModeChoices
            disabled={busy}
            mode={mode}
            onChange={(next) => change({ mode: next })}
            showSettingsNote={draft.scope === "everything"}
            workPolicy={workPolicy ?? undefined}
          />
          {dirty ? (
            <div className="form-actions">
              <button className="btn" disabled={busy} onClick={() => setEdit(null)} type="button">
                {agentWords("common.cancel")}
              </button>
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={requestSave}
                type="button"
              >
                {pending === "update" || creating
                  ? agentWords("common.saving")
                  : agentWords("common.save")}
              </button>
            </div>
          ) : saved ? (
            <p className="settings-footnote" role="status">
              {agentWords("agent.saved", { agent })}
            </p>
          ) : null}
          <SettingsError message={profileError} />
        </>
      ) : null}
      <SettingsGroup
        heading={agentWords("agent.activity.title")}
        headingId="connected-agent-activity"
      >
        <ActivityRows activity={detail.activity} />
      </SettingsGroup>
      <SettingsGroup heading={agentWords("agent.about.title")} headingId="connected-agent-about">
        {detail.about.map((row) => (
          <SettingsRow
            key={row.label}
            title={row.label}
            action={<span className="card__row-value">{row.value}</span>}
          />
        ))}
      </SettingsGroup>
      <SettingsError message={agents.error} />
      <div className="connected-agent__end">
        {connected && withdrawn ? null : connected ? (
          <button
            className="btn btn--danger"
            disabled={busy}
            onClick={() => setConfirming("disconnect")}
            type="button"
          >
            {pending === "revoke"
              ? agentWords("agent.disconnecting")
              : agentWords("agent.disconnect", { agent })}
          </button>
        ) : detail.row.removable ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              // Leaves the page only once it is gone; otherwise the page says why it is not.
              void agents.remove?.(connection.id).then((removed) => {
                if (removed) void navigate("..");
              })
            }
            type="button"
          >
            {pending === "remove"
              ? agentWords("disconnect.stopped.removing")
              : agentWords("disconnect.stopped.remove")}
          </button>
        ) : null}
      </div>
      {confirming === "disconnect" ? (
        <Dialog
          title={agentWords("agent.disconnect.title", { agent })}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirming(null)} type="button">
                {agentWords("common.cancel")}
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  setConfirming(null);
                  setEdit(null);
                  void agents.revoke?.(connection.id);
                }}
                type="button"
              >
                {agentWords("agent.disconnect.confirm")}
              </button>
            </>
          }
        >
          <p>{agentWords("agent.disconnect.body")}</p>
        </Dialog>
      ) : null}
      {confirming === "narrow" ? (
        <Dialog
          title={agentWords("agent.narrow.title", { agent })}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirming(null)} type="button">
                {agentWords("common.cancel")}
              </button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  setConfirming(null);
                  void save();
                }}
                type="button"
              >
                {agentWords("agent.narrow.confirm")}
              </button>
            </>
          }
        >
          <p>{agentWords("agent.narrow.body")}</p>
        </Dialog>
      ) : null}
    </>
  );
}

function StatusNotice({ status }: { readonly status: ConnectedAgentStatus }) {
  return (
    <div className="notice connected-agent__status" role="status">
      <span aria-hidden className={`status-dot status-dot--${dotTone(status.tone)}`} />
      <div>
        <strong className="connected-agent__status-label">{status.label}</strong>
        <span className="connected-agent__status-detail">{status.detail}</span>
        {status.steps.length ? (
          <ol className="connected-agent__steps">
            {status.steps.map((step) => (
              <li data-state={step.state} key={step.label}>
                {step.state === "done" ? <Icon name="check" /> : <span aria-hidden />}
                {step.label}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  );
}

function dotTone(tone: ConnectedAgentStatus["tone"]): string {
  return tone === "good" ? "ok" : tone === "attention" || tone === "bad" ? "warn" : "idle";
}

function ActivityRows({ activity }: { readonly activity: ConnectedAgentDetail["activity"] }) {
  if (activity.kind === "unavailable")
    return <SettingsRow title={agentWords("agent.activity.unavailable")} />;
  if (activity.items.length === 0)
    return <SettingsRow title={agentWords("agent.activity.empty")} />;
  return (
    <>
      {activity.items.map((item) => (
        <SettingsRow
          key={item.id}
          title={item.action}
          detail={item.at}
          action={<span className={`chip chip--${item.tone}`}>{item.outcome}</span>}
        />
      ))}
    </>
  );
}
