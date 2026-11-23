import { copyText } from "@opensteer/shared/clipboard";
import { SurfaceMenu } from "./surface-menu.js";
import { SectionHeader, SettingsSwitch } from "./settings/primitives.js";
import { IntegrationIcon } from "./integration-icon.js";
import { Link, useLocation } from "react-router";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  ChannelAccount,
  ChannelDashboard,
  ChannelProviderManifest,
} from "@opensteer/channel-core";
import {
  agentWords,
  homeFailureText,
  messagingAccountPart,
  messagingAccountTitle,
  sentenceWith,
  chatsOfAccount,
  connectedAgentRow,
  connectionsRead,
  messagingAccountView,
  type ConnectionsRead,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type CreatedChannelConnection,
  chatScreenHost,
  type ChatScreenHost,
  agentSentence,
  plainSentence,
} from "@opensteer/client/host";
import { homeIssueText } from "@opensteer/client/failure-text";
import { useConnectedAgents } from "@opensteer/client/react";
import type { AgentConnection } from "@opensteer/protocol";
import { useShell } from "./app-shell.js";
import { ComputerChannelSetup } from "./computer-channel-setup.js";
import { Dialog } from "./dialog.js";
import { ReadGate } from "./read-gate.js";
import { ExternalLink } from "./external-link.js";
import { Icon } from "./icon.js";
import { PageHeader, PageTopbar } from "./page-header.js";
import { useToast } from "./toast.js";
import { presentFailure } from "./use-action.js";
import { SentenceText } from "../ui/address-text.js";

type View = "overview" | "providers" | "setup" | "computer-setup" | "repair" | "success";

interface ChannelDraft {
  credentials: Record<string, string>;
  provider: string;
}

/** A code shown for linking "me": what to send, from where, until when. */
interface ShownCode {
  readonly accountId: string;
  readonly code: string;
  readonly expiresAt: string;
}

/**
 * Messaging: the person's own Slack and iMessage accounts, and the chats on each. A chat is a
 * connected agent reached through one of these accounts: its own page (Connected agents) is
 * where what it can use is chosen, where its work is stopped and where it is disconnected.
 * This page sets up the accounts, says who "me" is on each, and adds chats.
 */
export function MessagingPage({ embedded = false }: { readonly embedded?: boolean }) {
  const location = useLocation();
  const connectionId = location.pathname.startsWith("/settings/messaging/")
    ? decodeURIComponent(location.pathname.slice("/settings/messaging/".length))
    : null;
  const { hostClient, openMobileNavigation, snapshot } = useShell();
  const agents = useConnectedAgents(hostClient);
  // What this page sends and reads is what the chat parity script covers.
  const chatHost = chatScreenHost(hostClient);
  const [dashboard, setDashboard] = useState<ChannelDashboard | null>(null);
  const [view, setView] = useState<View>("overview");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const toast = useToast();
  const [created, setCreated] = useState<CreatedChannelConnection | null>(null);
  const [code, setCode] = useState<ShownCode | null>(null);
  const [repairing, setRepairing] = useState<{ connectionId: string; provider: string } | null>(
    null,
  );
  const [draft, setDraft] = useState<ChannelDraft>({ credentials: {}, provider: "" });

  const reload = useCallback(async () => {
    setDashboard(unwrapRpcResult(await chatHost.rpc["channels.get"]({})));
    setReadFailed(false);
  }, [chatHost]);

  useEffect(() => {
    let cancelled = false;
    chatHost.rpc["channels.get"]({})
      .then((result) => {
        if (!cancelled) setDashboard(unwrapRpcResult(result));
      })
      .catch(() => {
        if (!cancelled) setReadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [chatHost]);

  useEffect(() => {
    if (view !== "overview" && view !== "success") return;
    const timer = window.setInterval(() => {
      void reload().catch(() => setReadFailed(true));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [reload, view]);

  const provider = dashboard?.providers.find(
    ({ provider }) => provider === (repairing?.provider ?? draft.provider),
  );
  const credentialsReady = Boolean(
    provider?.credentialFields.every((field) => draft.credentials[field.key]?.trim()),
  );

  function startProvider(manifest: ChannelProviderManifest) {
    setError(null);
    setDraft({
      credentials: Object.fromEntries(manifest.credentialFields.map(({ key }) => [key, ""])),
      provider: manifest.provider,
    });
    // A transport that runs on one of your computers has nothing to paste.
    setView(manifest.transportKinds.includes("computer") ? "computer-setup" : "setup");
  }

  function startRepair(connectionId: string, providerId: string) {
    const manifest = dashboard?.providers.find(
      ({ provider: candidate }) => candidate === providerId,
    );
    if (!manifest) return;
    setError(null);
    setDraft((current) => ({
      ...current,
      credentials: Object.fromEntries(manifest.credentialFields.map(({ key }) => [key, ""])),
    }));
    setRepairing({ connectionId, provider: providerId });
    setView("repair");
  }

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credentialsReady) return;
    await run(async () => {
      const result = await chatHost.dispatch({
        credentials: Object.fromEntries(
          Object.entries(draft.credentials).map(([key, value]) => [key, value.trim()]),
        ),
        idempotencyKey: mutationIdempotencyKey("channel-connection"),
        provider: draft.provider,
        routingMode: "dedicated",
        type: "channel.connection.create",
      });
      if (result.type !== "channel.connection.create") throw new Error("Channel command mismatch.");
      setCreated(result);
      setDraft((current) => ({ ...current, credentials: {} }));
      setView("success");
      await reload();
    });
  }

  async function repair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repairing || !provider) return;
    const credentials = Object.fromEntries(
      Object.entries(draft.credentials).map(([key, value]) => [key, value.trim()]),
    );
    if (!provider.credentialFields.every(({ key }) => credentials[key])) return;
    await run(async () => {
      await chatHost.dispatch({
        connectionId: repairing.connectionId,
        credentials,
        idempotencyKey: mutationIdempotencyKey(`channel-credentials:${repairing.connectionId}`),
        type: "channel.connection.credentials.replace",
      });
      await reload();
      setDraft((current) => ({ ...current, credentials: {} }));
      setRepairing(null);
      setView("overview");
    });
  }

  async function check(connectionId: string, displayName: string) {
    await run(async () => {
      const inspection = unwrapRpcResult(
        await chatHost.rpc["channel.connection.check"]({ connectionId }),
      );
      await reload();
      if (inspection.ready) {
        toast.success(plainSentence([{ name: displayName }, ": checked."]));
        if (repairing) {
          setRepairing(null);
          setView("overview");
        }
      } else setError(homeIssueText(inspection.issues[0], "Setup is incomplete"));
    });
  }

  async function changeStatus(connectionId: string, status: "connected" | "paused" | "revoked") {
    await run(async () => {
      await chatHost.dispatch({
        connectionId,
        idempotencyKey: mutationIdempotencyKey(`channel-status:${connectionId}`),
        status,
        type: "channel.connection.status.set",
      });
      await reload();
      void agents.refresh?.();
    });
  }

  async function linkMe(accountId: string) {
    await run(async () => {
      const result = await chatHost.dispatch({
        accountId: accountId as never,
        idempotencyKey: mutationIdempotencyKey("channel-me-link"),
        type: "channel.me.link",
      });
      if (result.type !== "channel.me.link") throw new Error("Channel command mismatch.");
      setCode({ accountId, code: result.code, expiresAt: result.expiresAt });
    });
  }

  return (
    <div className={embedded ? "connected-apps__panel" : "page"}>
      {embedded ? null : (
        <PageTopbar onOpenNavigation={openMobileNavigation} title={agentWords("messaging.title")} />
      )}
      <div className="page__inner">
        {view !== "overview" ? (
          <button
            className="page__back"
            disabled={pending}
            onClick={() => {
              setError(null);
              if (view === "setup" || view === "computer-setup") setView("providers");
              else {
                setRepairing(null);
                setView("overview");
              }
            }}
            type="button"
          >
            <Icon name="arrow-left" />{" "}
            {view === "setup" || view === "computer-setup"
              ? "Providers"
              : agentWords("messaging.title")}
          </button>
        ) : null}

        {connectionId ? <Link to="/settings/messaging">All accounts</Link> : null}
        {view === "overview" ? (
          <>
            <SectionHeader
              title={agentWords("messaging.title")}
              action={
                <button
                  className="btn"
                  disabled={
                    readFailed ||
                    !dashboard?.providers.some(({ availability }) => availability === "available")
                  }
                  type="button"
                  onClick={() => {
                    setError(null);
                    setView("providers");
                  }}
                >
                  {agentWords("messaging.add")}
                </button>
              }
            />
            <p className="section__hint">{agentWords("messaging.lead")}</p>
          </>
        ) : (
          <PageHeader
            description={subheading(view)}
            eyebrow={agentWords("messaging.title")}
            title={heading(view, provider?.label)}
          />
        )}

        {view === "overview" ? (
          <ChannelOverview
            chats={agents.connections}
            chatsRead={connectionsRead(agents)}
            onRetryChats={() => void agents.refresh?.()}
            onRetry={() => void reload().catch(() => setReadFailed(true))}
            client={chatHost}
            code={code}
            dashboard={
              dashboard && connectionId
                ? {
                    ...dashboard,
                    connections: dashboard.connections.filter(({ id }) => id === connectionId),
                    accounts: dashboard.accounts.filter(
                      (account) => account.connectionId === connectionId,
                    ),
                  }
                : dashboard
            }
            error={error}
            names={{ profiles: snapshot.browserProfiles }}
            onAdd={() => {
              setError(null);
              setView("providers");
            }}
            onChatAdded={() => void agents.refresh?.()}
            onCheck={(id, displayName) => void check(id, displayName)}
            onLinkMe={(accountId) => void linkMe(accountId)}
            onRepair={startRepair}
            onRemove={(id) => void changeStatus(id, "revoked")}
            onStatus={(id, status) => void changeStatus(id, status)}
            pending={pending}
            readFailed={readFailed}
          />
        ) : null}

        {view === "providers" ? (
          <ProviderPicker dashboard={dashboard} onSelect={startProvider} />
        ) : null}

        {view === "computer-setup" && provider ? (
          <ComputerChannelSetup
            hostClient={chatHost}
            machines={snapshot.machines}
            onCancel={() => setView("providers")}
            onCreated={(result) => {
              setCreated(result);
              setView("success");
              void reload();
            }}
            provider={provider}
          />
        ) : null}

        {view === "setup" && provider ? (
          <form className="section" onSubmit={(event) => void connect(event)}>
            <ProviderCredentials
              draft={draft}
              onOpenError={(reason) => setError(message(reason))}
              provider={provider}
              setDraft={setDraft}
            />
            <div className="form-actions">
              {error ? (
                <span aria-live="assertive" className="form-actions__error" role="alert">
                  {error}
                </span>
              ) : null}
              <button
                className="btn"
                disabled={pending}
                onClick={() => setView("providers")}
                type="button"
              >
                Back
              </button>
              <button
                className="btn btn--primary"
                disabled={!credentialsReady || pending}
                type="submit"
              >
                {pending ? "Checking…" : `Connect ${provider.label}`}
              </button>
            </div>
          </form>
        ) : null}

        {view === "repair" && provider && repairing ? (
          <form className="section" onSubmit={(event) => void repair(event)}>
            <ProviderCredentials
              draft={draft}
              onOpenError={(reason) => setError(message(reason))}
              provider={provider}
              setDraft={setDraft}
            />
            <div className="form-actions">
              {error ? (
                <span aria-live="assertive" className="form-actions__error" role="alert">
                  {error}
                </span>
              ) : null}
              <button
                className="btn"
                disabled={pending}
                onClick={() => void check(repairing.connectionId, provider.label)}
                type="button"
              >
                {agentWords("messaging.check")}
              </button>
              <button
                className="btn btn--primary"
                disabled={pending || !credentialsReady}
                type="submit"
              >
                {pending ? "Checking…" : "Update credentials"}
              </button>
            </div>
          </form>
        ) : null}

        {view === "success" && created ? (
          <ConnectionSuccess
            connection={
              dashboard?.connections.find(({ id }) => id === created.connection.id) ??
              created.connection
            }
            onDone={() => {
              setCreated(null);
              setView("overview");
            }}
            providerLabel={provider?.label ?? "Messaging"}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Every messaging account this person owns: its state and controls, who "me" is on it, and
 * its chats, each a connected agent whose own page holds what it can use, Stop and Disconnect.
 */
export function ChannelOverview({
  chats,
  chatsRead,
  onRetryChats,
  onRetry,
  client,
  code,
  dashboard,
  error,
  names,
  onAdd,
  onChatAdded,
  onCheck,
  onLinkMe,
  onRepair,
  onRemove,
  onStatus,
  pending,
  readFailed,
}: {
  readonly chats: readonly AgentConnection[] | null;
  /** Where the read of the chats stands: only a read answer says an account has none. */
  readonly chatsRead: ConnectionsRead;
  readonly onRetryChats: () => void;
  /** Read the accounts again after a read that failed. */
  readonly onRetry: () => void;
  readonly client: Pick<ChatScreenHost, "dispatch">;
  readonly code: ShownCode | null;
  readonly dashboard: ChannelDashboard | null;
  readonly error: string | null;
  readonly names: Parameters<typeof connectedAgentRow>[1];
  readonly onAdd: () => void;
  readonly onChatAdded: () => void;
  readonly onCheck: (connectionId: string, displayName: string) => void;
  readonly onLinkMe: (accountId: string) => void;
  readonly onRepair: (connectionId: string, provider: string) => void;
  readonly onRemove: (connectionId: string) => void;
  readonly onStatus: (connectionId: string, status: "connected" | "paused") => void;
  readonly pending: boolean;
  readonly readFailed: boolean;
}) {
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  // A read that failed says so: it never shows accounts as connected or as gone.
  if (readFailed && !dashboard)
    return (
      <p className="notice notice--error" role="alert">
        <Icon name="alert-circle" />
        <span>{agentWords("messaging.readFailed")}</span>{" "}
        <button className="btn btn--small" onClick={onRetry} type="button">
          {agentWords("common.tryAgain")}
        </button>
      </p>
    );
  if (!dashboard)
    return (
      <div className="section">
        <span className="section__hint">
          <span className="spinner" role="status" aria-label="Loading" />{" "}
          {agentWords("messaging.loading")}
        </span>
      </div>
    );
  const providerReady = dashboard.providers.some(
    ({ availability }) => availability === "available",
  );
  // While the last read failed, nothing here changes anything: one gate for the page and its
  // dialogs, whose Try again reads the accounts and the chats again.
  return (
    <ReadGate
      failed={readFailed}
      message={agentWords("messaging.readFailed")}
      onRetry={() => {
        onRetry();
        onRetryChats();
      }}
    >
      {error ? (
        <p aria-live="assertive" className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="messaging-overview">
        {dashboard.connections.length === 0 ? (
          <div className="card">
            <div className="card__empty">
              <p>{agentWords("messaging.empty")}</p>
              <button
                className="btn btn--primary"
                disabled={!providerReady}
                onClick={onAdd}
                type="button"
              >
                {agentWords("messaging.add")}
              </button>
            </div>
          </div>
        ) : null}
        {dashboard.connections.map((connection) => {
          const manifest = dashboard.providers.find(
            ({ provider }) => provider === connection.provider,
          );
          const providerLabel = manifest?.label ?? connection.provider;
          const accounts = dashboard.accounts.filter(
            ({ connectionId }) => connectionId === connection.id,
          );
          // The account as the Home states it, and the controls it accepts (shared with the phone).
          const view = messagingAccountView(connection, manifest);
          return (
            <section className="section messaging-account" key={connection.id}>
              <div className="card">
                <div className="card__row settings-messaging-row">
                  <IntegrationIcon id={connection.provider} name={providerLabel} />
                  <div className="card__row-body">
                    <span className="card__row-title">
                      <Link to={`/settings/messaging/${encodeURIComponent(connection.id)}`}>
                        <SentenceText parts={[messagingAccountTitle(connection, accounts)]} />
                      </Link>
                      {/* A read that failed leaves the last answer on screen, never as current. */}
                      <span className={`chip ${readFailed ? "" : statusChip(connection.status)}`}>
                        {readFailed ? agentWords("messaging.status.stale") : view.label}
                      </span>
                    </span>
                    <span className="card__row-detail">{providerLabel}</span>
                    {view.pausedNote ? (
                      <span className="card__row-detail">{view.pausedNote}</span>
                    ) : null}
                    {view.detail ? <span className="card__row-detail">{view.detail}</span> : null}
                  </div>
                  <div className="card__row-actions">
                    {view.canFix ? (
                      <button
                        className="btn btn--small"
                        disabled={pending}
                        type="button"
                        onClick={() => onRepair(connection.id, connection.provider)}
                      >
                        {agentWords("messaging.fix")}
                      </button>
                    ) : !view.canPause && !view.canResume ? null : (
                      <SettingsSwitch
                        label={plainSentence([
                          view.canResume
                            ? agentWords("messaging.resume")
                            : agentWords("messaging.pause"),
                          " ",
                          { name: connection.displayName },
                        ])}
                        checked={view.canPause}
                        disabled={pending || readFailed}
                        onChange={(enabled) =>
                          onStatus(connection.id, enabled ? "connected" : "paused")
                        }
                      />
                    )}
                    <SurfaceMenu
                      label={plainSentence(["Actions for ", { name: connection.displayName }])}
                      items={[
                        {
                          icon: "reload",
                          label: agentWords("messaging.check"),
                          disabled: pending,
                          onSelect: () => onCheck(connection.id, connection.displayName),
                        },
                        {
                          icon: "trash",
                          label: agentWords("messaging.remove"),
                          danger: true,
                          disabled: pending,
                          onSelect: () =>
                            setRemoving({ id: connection.id, name: connection.displayName }),
                        },
                      ]}
                    />
                  </div>
                </div>
                {accounts.map((account) => (
                  <AccountChats
                    account={account}
                    chats={chatsRead === "read" ? chatsOfAccount(chats, account.id) : chatsRead}
                    onRetryChats={onRetryChats}
                    client={client}
                    code={code?.accountId === account.id ? code : null}
                    key={account.id}
                    manifest={manifest}
                    me={dashboard.me?.find(({ accountId }) => accountId === account.id) ?? null}
                    names={names}
                    onChatAdded={onChatAdded}
                    onLinkMe={() => onLinkMe(account.id)}
                    paused={view.canResume}
                    needsAttention={connection.status === "needs-attention"}
                    pending={pending}
                    providerLabel={providerLabel}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {removing ? (
        <Dialog
          title={
            <SentenceText
              parts={agentSentence("messaging.remove.title", { account: { name: removing.name } })}
            />
          }
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setRemoving(null)} type="button">
                {agentWords("common.cancel")}
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  onRemove(removing.id);
                  setRemoving(null);
                }}
                type="button"
              >
                {agentWords("messaging.remove")}
              </button>
            </>
          }
        >
          <p>{agentWords("messaging.remove.body")}</p>
        </Dialog>
      ) : null}
    </ReadGate>
  );
}

/** Who "me" is on one account, the code that links it, and the chats that speak through it. */
export function AccountChats({
  account,
  chats,
  onRetryChats,
  client,
  code,
  manifest,
  me,
  names,
  onChatAdded,
  onLinkMe,
  paused,
  needsAttention,
  pending,
  providerLabel,
}: {
  readonly account: ChannelAccount;
  /** Its chats once read; or that they are still being read, or could not be. */
  readonly chats: readonly AgentConnection[] | "loading" | "failed";
  readonly onRetryChats: () => void;
  readonly client: Pick<ChatScreenHost, "dispatch">;
  readonly code: ShownCode | null;
  readonly manifest: ChannelProviderManifest | undefined;
  readonly me: { readonly displayName: string } | null;
  readonly names: Parameters<typeof connectedAgentRow>[1];
  readonly onChatAdded: () => void;
  readonly onLinkMe: () => void;
  /** Its account is paused: a code sent now links it only once the account is resumed. */
  readonly paused: boolean;
  /** Its account needs attention: a code links it only once it is fixed. */
  readonly needsAttention: boolean;
  readonly pending: boolean;
  readonly providerLabel: string;
}) {
  const [adding, setAdding] = useState(false);
  const accountPart = messagingAccountPart(account);
  return (
    <>
      <div className="card__row messaging-me">
        <div className="card__row-body">
          <span className="card__row-title">
            {agentWords("messaging.me.title", { provider: providerLabel })}
          </span>
          <span className="card__row-detail">
            <SentenceText
              parts={
                me
                  ? sentenceWith(
                      (slot) => agentWords("messaging.me.linked", { identity: slot("me") }),
                      { me: { name: me.displayName } },
                    )
                  : [agentWords("messaging.me.none", { provider: providerLabel })]
              }
            />
          </span>
          {code ? (
            <span className="card__row-detail" role="status">
              <SentenceText
                parts={sentenceWith(
                  (slot) =>
                    agentWords("messaging.me.code", {
                      code: code.code,
                      account: slot("account"),
                      provider: providerLabel,
                      time: new Date(code.expiresAt).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    }),
                  { account: accountPart },
                )}
              />
              {paused ? ` ${agentWords("messaging.me.whenResumed")}` : null}
              {needsAttention ? ` ${agentWords("messaging.me.whenFixed")}` : null}
            </span>
          ) : null}
          {me ? (
            <span className="card__row-detail">
              <SentenceText
                parts={sentenceWith(
                  (slot) => agentWords("messaging.me.replaces", { identity: slot("me") }),
                  { me: { name: me.displayName } },
                )}
              />
            </span>
          ) : null}
        </div>
        <div className="card__row-actions">
          {code ? (
            <button
              className="btn btn--small"
              onClick={() => void copyText(code.code)}
              type="button"
            >
              <Icon name="copy" /> Copy
            </button>
          ) : null}
          <button className="btn btn--small" disabled={pending} onClick={onLinkMe} type="button">
            {me ? agentWords("messaging.me.relink") : agentWords("messaging.me.link")}
          </button>
        </div>
      </div>
      <div className="card__row messaging-chats">
        <div className="card__row-body">
          <span className="card__row-title">{agentWords("messaging.chats.title")}</span>
          {chats === "loading" ? (
            <span className="card__row-detail" role="status">
              {agentWords("messaging.chats.loading")}
            </span>
          ) : chats === "failed" ? (
            <span className="card__row-detail" role="alert">
              {agentWords("messaging.chats.readFailed")}{" "}
              <button className="btn btn--small" onClick={onRetryChats} type="button">
                {agentWords("common.tryAgain")}
              </button>
            </span>
          ) : chats.length === 0 ? (
            <span className="card__row-detail">{agentWords("messaging.chats.empty")}</span>
          ) : (
            <ul className="messaging-chats__list">
              {chats.map((chat) => {
                const row = connectedAgentRow(chat, names);
                return (
                  <li key={chat.id}>
                    <Link to={`/settings/external-agents/${encodeURIComponent(chat.id)}`}>
                      {chat.label}
                    </Link>{" "}
                    <span className="card__row-detail">
                      <SentenceText parts={row.lineParts} />
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="card__row-actions">
          {adding ? null : (
            <button
              className="btn btn--small"
              disabled={pending || account.status === "revoked"}
              onClick={() => setAdding(true)}
              type="button"
            >
              {agentWords("messaging.chats.add")}
            </button>
          )}
        </div>
      </div>
      {adding ? (
        <AddChatForm
          account={account}
          channels={manifest?.channelChats === true}
          client={client}
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            onChatAdded();
          }}
          providerLabel={providerLabel}
        />
      ) : null}
    </>
  );
}

/**
 * Adds a chat: its direct messages, or one channel; who may give it work, chosen now and never
 * changed; at Supervised with Tasks only, widened on its own page with the grant editor.
 */
export function AddChatForm({
  account,
  channels,
  client,
  onCancel,
  onCreated,
  providerLabel,
}: {
  readonly account: ChannelAccount;
  /** The provider has channels a chat can listen in; otherwise only direct messages. */
  readonly channels: boolean;
  readonly client: Pick<ChatScreenHost, "dispatch">;
  readonly onCancel: () => void;
  readonly onCreated: (chat: AgentConnection) => void;
  readonly providerLabel: string;
}) {
  const [where, setWhere] = useState<"dm" | "channel">("dm");
  const [channelId, setChannelId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [senders, setSenders] = useState<"owner" | "anyone">("owner");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channel = where === "channel";
  const ready = !channel || (channelId.trim() !== "" && channelName.trim() !== "");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      const result = await client.dispatch({
        accountId: account.id,
        conversation: channel
          ? { id: channelId.trim(), name: channelName.trim().replace(/^(?!#)/u, "#") }
          : null,
        senders: channel ? senders : "owner",
        accessMode: "approval-required",
        grant: { scope: "selected", tasks: true, resources: [] },
        idempotencyKey: mutationIdempotencyKey("channel-chat"),
        type: "channel.chat.create",
      });
      if (result.type !== "channel.chat.create") throw new Error("Channel command mismatch.");
      onCreated(result.connection);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="card__form messaging-add-chat" onSubmit={(event) => void submit(event)}>
      {channels ? (
        <fieldset className="check-list">
          <legend className="field__label">{agentWords("messaging.chat.where")}</legend>
          {(["dm", "channel"] as const).map((option) => (
            <label className="check-item" key={option}>
              <input
                checked={where === option}
                name={`chat-where-${account.id}`}
                onChange={() => {
                  setWhere(option);
                  if (option === "dm") setSenders("owner");
                }}
                type="radio"
              />
              <span className="check-item__label">
                {agentWords(option === "dm" ? "messaging.chat.dm" : "messaging.chat.channel")}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {channel ? (
        <>
          <label className="field">
            <span className="field__label">{agentWords("messaging.chat.channelId")}</span>
            <input
              className="text-input"
              onChange={(event) => setChannelId(event.currentTarget.value)}
              value={channelId}
            />
            <span className="field__hint">
              {agentWords("messaging.chat.channelIdHint", { provider: providerLabel })}
            </span>
          </label>
          <label className="field">
            <span className="field__label">{agentWords("messaging.chat.channelName")}</span>
            <input
              className="text-input"
              onChange={(event) => setChannelName(event.currentTarget.value)}
              value={channelName}
            />
          </label>
          <fieldset className="check-list">
            <legend className="field__label">{agentWords("messaging.chat.speakers")}</legend>
            {(["owner", "anyone"] as const).map((option) => (
              <label className="check-item" key={option}>
                <input
                  checked={senders === option}
                  name={`chat-senders-${account.id}`}
                  onChange={() => setSenders(option)}
                  type="radio"
                />
                <span className="check-item__meta">
                  <span className="check-item__label">
                    {agentWords(option === "owner" ? "messaging.chat.me" : "messaging.chat.anyone")}
                  </span>
                  <span className="check-item__detail">
                    {agentWords(
                      option === "owner"
                        ? "messaging.chat.meDetail"
                        : "messaging.chat.anyoneDetail",
                    )}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </>
      ) : (
        <p className="field__hint">{agentWords("messaging.chat.meDetail")}</p>
      )}
      <p className="field__hint">{agentWords("messaging.chat.fixed")}</p>
      <p className="field__hint">{agentWords("messaging.chat.grant")}</p>
      <div className="form-actions">
        {error ? (
          <span aria-live="assertive" className="form-actions__error" role="alert">
            {error}
          </span>
        ) : null}
        <button className="btn" disabled={pending} onClick={onCancel} type="button">
          {agentWords("messaging.chat.cancel")}
        </button>
        <button className="btn btn--primary" disabled={pending || !ready} type="submit">
          {pending ? agentWords("messaging.chat.creating") : agentWords("messaging.chat.create")}
        </button>
      </div>
    </form>
  );
}

function ProviderPicker({
  dashboard,
  onSelect,
}: {
  dashboard: ChannelDashboard | null;
  onSelect: (provider: ChannelProviderManifest) => void;
}) {
  return (
    <section className="section">
      <div className="card">
        {(dashboard?.providers ?? []).map((provider) => (
          <div className="card__row" key={provider.provider}>
            <span className="card__row-glyph" aria-hidden="true">
              {provider.label.slice(0, 1).toUpperCase()}
            </span>
            <div className="card__row-body">
              <span className="card__row-title">{provider.label}</span>
              <span className="card__row-detail">{provider.description}</span>
            </div>
            <div className="card__row-actions">
              {provider.availability === "available" ? (
                <button
                  className="btn btn--primary btn--small"
                  onClick={() => onSelect(provider)}
                  type="button"
                >
                  Connect
                </button>
              ) : (
                <span className="chip">Starting</span>
              )}
            </div>
          </div>
        ))}
        {dashboard && dashboard.providers.length === 0 ? (
          <div className="card__empty">No messaging providers are available on this Home yet.</div>
        ) : null}
      </div>
    </section>
  );
}

function ProviderCredentials({
  draft,
  onOpenError,
  provider,
  setDraft,
}: {
  draft: ChannelDraft;
  setDraft: (draft: ChannelDraft) => void;
  onOpenError: (reason: unknown) => void;
  provider: ChannelProviderManifest;
}) {
  const [copiedManifest, setCopiedManifest] = useState(false);
  return (
    <div className="card">
      <div className="card__form">
        <p className="section__hint">
          Create the provider app, then paste the two credentials Opensteer needs. They are checked
          before anything is saved.
        </p>
        {provider.provider === "slack" ? (
          <ol className="channel-setup-steps">
            <li>
              <strong>Create a Slack app from the manifest.</strong> Copy the manifest below and
              paste it into Slack’s “From an app manifest” flow.
            </li>
            <li>
              <strong>Install the app to your workspace.</strong> Copy the Bot User OAuth Token
              beginning with <code>xoxb-</code>.
            </li>
            <li>
              <strong>Enable Socket Mode.</strong> Create an app-level token with the
              <code>connections:write</code> scope, then copy the token beginning with
              <code>xapp-</code>.
            </li>
          </ol>
        ) : null}
        {provider.setupArtifact ? (
          <details className="channel-setup-details">
            <summary>Show {provider.label} app manifest</summary>
            <div className="channel-setup-details__body">
              <textarea
                aria-label={`${provider.label} setup manifest`}
                className="code-editor"
                readOnly
                rows={8}
                value={provider.setupArtifact.content}
              />
              <div className="form-actions">
                <button
                  className="btn btn--small"
                  onClick={() => {
                    const content = provider.setupArtifact?.content;
                    if (!content) return;
                    void copyText(content).then((success) => {
                      if (!success) {
                        onOpenError(new Error("Copy was blocked. Select the text to copy it."));
                        return;
                      }
                      setCopiedManifest(true);
                      window.setTimeout(() => setCopiedManifest(false), 1_500);
                    });
                  }}
                  type="button"
                >
                  <Icon name="copy" /> {copiedManifest ? "Copied" : "Copy manifest"}
                </button>
                {provider.setupUrl ? (
                  <ExternalLink
                    className="btn btn--ghost btn--small"
                    href={provider.setupUrl}
                    onOpenError={onOpenError}
                  >
                    <Icon name="external-link" /> Open {provider.label} setup
                  </ExternalLink>
                ) : null}
              </div>
            </div>
          </details>
        ) : null}
        {provider.credentialFields.map((field, index) => (
          <label className="field" key={field.key}>
            <span className="field__label">{field.label}</span>
            <input
              autoComplete="off"
              autoFocus={index === 0}
              className="text-input"
              onChange={(event) =>
                setDraft({
                  ...draft,
                  credentials: { ...draft.credentials, [field.key]: event.currentTarget.value },
                })
              }
              placeholder={field.placeholder}
              required
              type={field.secret ? "password" : "text"}
              value={draft.credentials[field.key] ?? ""}
            />
            {field.help ? <span className="field__hint">{field.help}</span> : null}
          </label>
        ))}
        <p className="notice">
          These tokens are stored encrypted and are not given to connected agents or your own
          agents.
        </p>
      </div>
    </div>
  );
}

function ConnectionSuccess({
  connection,
  onDone,
  providerLabel,
}: {
  connection: CreatedChannelConnection["connection"];
  onDone: () => void;
  providerLabel: string;
}) {
  return (
    <section className="section">
      {connection.status === "connected" ? (
        <p className="notice notice--accent">
          Opensteer checked the {providerLabel} account and is connected to it.
        </p>
      ) : (
        <p className="notice notice--warn">
          {connection.status === "pending"
            ? "Connecting to the messaging service…"
            : "The connection needs attention."}
          {connection.statusDetail
            ? ` ${connection.statusDetail}`
            : " You can check its status from Messaging."}
        </p>
      )}
      <div className="card">
        <div className="card__row">
          <div className="card__row-body">
            <span className="card__row-title">Next, link your own account</span>
            <span className="card__row-detail">
              Link my account shows a code to send from your own {providerLabel} account, so
              Opensteer knows which messages are yours.
            </span>
          </div>
        </div>
        <div className="card__row">
          <div className="card__row-body">
            <span className="card__row-title">Then add a chat</span>
            <span className="card__row-detail">
              A chat is a connected agent for its direct messages or one channel. Choose what it can
              use on its page.
            </span>
          </div>
        </div>
      </div>
      <div className="form-actions">
        <button className="btn btn--primary" onClick={onDone} type="button">
          Done
        </button>
      </div>
    </section>
  );
}

function heading(view: View, providerLabel = "provider"): string {
  if (view === "providers") return "Add a messaging account";
  if (view === "success") return `${providerLabel} account added`;
  if (view === "repair") return `Fix ${providerLabel} setup`;
  return `Connect ${providerLabel}`;
}

function subheading(view: View): string {
  if (view === "providers") return "Choose where you want to message your own agents from.";
  if (view === "success") return "Link your own account, then add a chat.";
  if (view === "repair")
    return "Finish any provider-side changes, check again, or replace the saved credentials.";
  if (view === "computer-setup") return "Your own agents answer from one of your Macs.";
  return "Bring a provider app you control. Its tokens are checked before anything is saved.";
}

function statusChip(status: string): string {
  return status === "connected"
    ? "chip--ok"
    : status === "needs-attention"
      ? "chip--warn"
      : status === "revoked"
        ? "chip--bad"
        : "";
}

/** The Home's own sentence when it refused in words for the person; otherwise the app's. */
function message(reason: unknown): string {
  return homeFailureText(reason, presentFailure(reason, "change messaging settings"));
}
