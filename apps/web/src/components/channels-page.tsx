import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  ChannelAccessPolicy,
  ChannelAccount,
  ChannelBinding,
  ChannelDashboard,
  ChannelProviderManifest,
  ChannelRouteSelector,
} from "@opensteer/channel-core";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type CreatedChannelConnection,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useShell } from "./app-shell.js";
import { ComputerChannelSetup } from "./computer-channel-setup.js";
import { ExternalLink } from "./external-link.js";
import { Icon } from "./icon.js";
import { PageHeader, PageTopbar } from "./page-header.js";
import { useToast } from "./toast.js";

type View = "overview" | "providers" | "setup" | "computer-setup" | "repair" | "success";

/** The Host mints codes from this alphabet, which omits look-alike glyphs. */
const linkCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const linkCodeLength = 8;

/** Admission choices are shared by channel mentions and direct messages. */
const senderModes = ["anyone", "owner", "approved", "linked-members", "off"] as const;
type SenderMode = (typeof senderModes)[number];

interface LinkedIdentity {
  displayName: string;
  providerLabel: string;
}

interface RouteDraft {
  accessPolicy: ChannelAccessPolicy;
  conversationId: string;
  workspaceId: string;
}

interface ChannelDraft {
  accessPolicy: ChannelAccessPolicy;
  channelInput: string;
  credentials: Record<string, string>;
  provider: string;
  routingMode: "dedicated" | "shared";
  workspaceId: string;
}

/** Routed page for connecting messaging accounts and routing them to Workspaces. */
export function ChannelsPage({ embedded = false }: { readonly embedded?: boolean }) {
  const { hostClient, openMobileNavigation, snapshot } = useShell();
  const workspaces = snapshot.workspaces;
  const homeWorkspaceId =
    snapshot.homeWorkspaceId ??
    workspaces.find(({ kind }) => kind === "main")?.id ??
    workspaces[0]?.id ??
    "";
  const [dashboard, setDashboard] = useState<ChannelDashboard | null>(null);
  const [view, setView] = useState<View>("overview");
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const [created, setCreated] = useState<CreatedChannelConnection | null>(null);
  const [linked, setLinked] = useState<LinkedIdentity | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<{ connectionId: string; provider: string } | null>(
    null,
  );
  const [draft, setDraft] = useState<ChannelDraft>({
    accessPolicy: defaultChannelAccessPolicy(),
    channelInput: "",
    credentials: {},
    provider: "",
    routingMode: "dedicated",
    workspaceId: homeWorkspaceId,
  });

  const reload = useCallback(async () => {
    setDashboard(unwrapRpcResult(await hostClient.rpc["channels.get"]({})));
  }, [hostClient]);

  useEffect(() => {
    let cancelled = false;
    hostClient.rpc["channels.get"]({})
      .then((result) => {
        if (!cancelled) setDashboard(unwrapRpcResult(result));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(message(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [hostClient]);

  useEffect(() => {
    if (view !== "overview" && view !== "success") return;
    const timer = window.setInterval(() => {
      void reload().catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [reload, view]);

  const workspace = workspaces.find(({ id }) => id === draft.workspaceId);
  const provider = dashboard?.providers.find(
    ({ provider }) => provider === (repairing?.provider ?? draft.provider),
  );
  const routeSummary =
    draft.routingMode === "dedicated"
      ? "This identity always represents this Workspace"
      : "Shared bot with editable routes";
  const canContinue =
    step === 0
      ? Boolean(provider?.credentialFields.every((field) => draft.credentials[field.key]?.trim()))
      : step === 1
        ? Boolean(workspace)
        : step === 2 && draft.accessPolicy.channels.scope === "selected"
          ? normalizeChannelIds(draft.channelInput).length > 0
          : true;

  function startProvider(manifest: ChannelProviderManifest) {
    setError(null);
    setDraft((current) => ({
      ...current,
      credentials: Object.fromEntries(manifest.credentialFields.map(({ key }) => [key, ""])),
      provider: manifest.provider,
      workspaceId: current.workspaceId || homeWorkspaceId,
    }));
    setStep(0);
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

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < 3) {
      if (canContinue) setStep((current) => current + 1);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await hostClient.dispatch({
        accessPolicy: accessPolicyFromDraft(draft.accessPolicy, draft.channelInput),
        credentials: Object.fromEntries(
          Object.entries(draft.credentials).map(([key, value]) => [key, value.trim()]),
        ),
        idempotencyKey: mutationIdempotencyKey("channel-connection"),
        provider: draft.provider,
        routingMode: draft.routingMode,
        type: "channel.connection.create",
        workspaceId: draft.workspaceId,
      });
      if (result.type !== "channel.connection.create") throw new Error("Channel command mismatch.");
      setCreated(result);
      setDraft((current) => ({ ...current, credentials: {} }));
      setView("success");
      await reload();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  async function repair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repairing || !provider) return;
    const credentials = Object.fromEntries(
      Object.entries(draft.credentials).map(([key, value]) => [key, value.trim()]),
    );
    if (!provider.credentialFields.every(({ key }) => credentials[key])) return;
    setPending(true);
    setError(null);
    try {
      await hostClient.dispatch({
        connectionId: repairing.connectionId,
        credentials,
        idempotencyKey: mutationIdempotencyKey(`channel-credentials:${repairing.connectionId}`),
        type: "channel.connection.credentials.replace",
      });
      await reload();
      setDraft((current) => ({ ...current, credentials: {} }));
      setRepairing(null);
      setView("overview");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  async function checkRepair() {
    if (!repairing) return;
    setPending(true);
    setError(null);
    try {
      const inspection = unwrapRpcResult(
        await hostClient.rpc["channel.connection.check"]({ connectionId: repairing.connectionId }),
      );
      await reload();
      if (inspection.ready) {
        setRepairing(null);
        setView("overview");
      } else setError(inspection.issues[0]?.message ?? "Setup is incomplete");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  async function checkConnection(connectionId: string, displayName: string) {
    setPending(true);
    setError(null);
    try {
      const inspection = unwrapRpcResult(
        await hostClient.rpc["channel.connection.check"]({ connectionId }),
      );
      await reload();
      if (inspection.ready)
        toast.success(`${displayName}: tokens verified. Connection status is shown below.`);
      else setError(inspection.issues[0]?.message ?? "Setup is incomplete");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  async function changeStatus(connectionId: string, status: "connected" | "paused" | "revoked") {
    setPending(true);
    setError(null);
    try {
      await hostClient.dispatch({
        connectionId,
        idempotencyKey: mutationIdempotencyKey(`channel-status:${connectionId}`),
        status,
        type: "channel.connection.status.set",
      });
      await reload();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  /**
   * Redeems a code the bot issued in chat against the signed-in account, and
   * answers whether it was spent so the field can keep a code that was not.
   */
  async function linkIdentity(code: string): Promise<boolean> {
    setPending(true);
    setLinkError(null);
    try {
      const result = await hostClient.dispatch({
        code,
        idempotencyKey: mutationIdempotencyKey("channel-identity-link"),
        type: "channel.identity.link",
      });
      if (result.type !== "channel.identity.link") throw new Error("Channel command mismatch.");
      setLinked({
        displayName: result.identity.displayName,
        providerLabel: providerLabelFor(dashboard, result.account.provider),
      });
      await reload();
      return true;
    } catch (reason) {
      setLinked(null);
      setLinkError(message(reason));
      return false;
    } finally {
      setPending(false);
    }
  }

  /** Answers whether the route was created, so the card can close its form. */
  async function addRoute(account: ChannelAccount, route: RouteDraft): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const result = await hostClient.dispatch({
        accessPolicy: accessPolicyFromDraft(route.accessPolicy, route.conversationId),
        accountId: account.id,
        executionPolicy: { harness: "default", harnessInstanceId: null },
        idempotencyKey: mutationIdempotencyKey(`channel-binding:${account.id}`),
        selector: {
          conversationId:
            normalizeChannelIds(route.conversationId)[0] ?? route.conversationId.trim(),
          conversationType: null,
          scopeId: null,
          threadId: null,
        },
        type: "channel.binding.create",
        workspaceId: route.workspaceId,
      });
      if (result.type !== "channel.binding.create") throw new Error("Channel command mismatch.");
      await reload();
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setPending(false);
    }
  }

  /** Retires one route. The binding stays as a revoked row, so the list shows it. */
  async function revokeRoute(bindingId: ChannelBinding["id"]): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await hostClient.dispatch({
        bindingId,
        idempotencyKey: mutationIdempotencyKey(`channel-binding-revoke:${bindingId}`),
        type: "channel.binding.revoke",
      });
      if (result.type !== "channel.binding.revoke") throw new Error("Channel command mismatch.");
      await reload();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  async function updateAccess(binding: ChannelBinding, accessPolicy: ChannelAccessPolicy) {
    setPending(true);
    setError(null);
    try {
      const result = await hostClient.dispatch({
        accessPolicy,
        bindingId: binding.id,
        expectedRevision: binding.revision,
        idempotencyKey: mutationIdempotencyKey(`channel-binding-access:${binding.id}`),
        type: "channel.binding.update",
      });
      if (result.type !== "channel.binding.update") throw new Error("Channel command mismatch.");
      await reload();
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function reviewAccess(
    grant: ChannelDashboard["accessGrants"][number],
    decision: "approved" | "declined" | "revoked",
  ) {
    setPending(true);
    setError(null);
    try {
      const result = await hostClient.dispatch({
        bindingId: grant.bindingId,
        decision,
        expectedRevision: grant.revision,
        externalUserId: grant.externalUserId,
        idempotencyKey: mutationIdempotencyKey(
          `channel-access:${grant.bindingId}:${grant.externalUserId}:${decision}`,
        ),
        type: "channel.access.review",
      });
      if (result.type !== "channel.access.review") throw new Error("Channel command mismatch.");
      await reload();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={embedded ? "connected-apps__panel" : "page"}>
      {embedded ? null : <PageTopbar onOpenNavigation={openMobileNavigation} title="Messaging" />}
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
            {view === "setup" || view === "computer-setup" ? "Providers" : "Messaging"}
          </button>
        ) : null}

        <PageHeader
          description={subheading(view, step, provider?.label)}
          eyebrow="Messaging"
          title={heading(view, step, provider?.label)}
        />

        {view === "overview" ? (
          <ChannelOverview
            dashboard={dashboard}
            error={error}
            homeWorkspaceId={homeWorkspaceId}
            linkError={linkError}
            linked={linked}
            onAdd={() => {
              setError(null);
              setView("providers");
            }}
            onAddRoute={addRoute}
            onCheck={(connectionId, displayName) => void checkConnection(connectionId, displayName)}
            onLink={linkIdentity}
            onRepair={startRepair}
            onReviewAccess={(grant, decision) => void reviewAccess(grant, decision)}
            onRevoke={(connectionId) => void changeStatus(connectionId, "revoked")}
            onRevokeRoute={(bindingId) => void revokeRoute(bindingId)}
            onStatus={(connectionId, status) => void changeStatus(connectionId, status)}
            onUpdateAccess={updateAccess}
            pending={pending}
            workspaces={workspaces}
          />
        ) : null}

        {view === "providers" ? (
          <ProviderPicker dashboard={dashboard} onSelect={startProvider} />
        ) : null}

        {view === "computer-setup" && provider ? (
          <ComputerChannelSetup
            defaultWorkspaceId={draft.workspaceId || homeWorkspaceId}
            hostClient={hostClient}
            machines={snapshot.machines}
            onCancel={() => setView("providers")}
            onCreated={(result) => {
              setCreated(result);
              setView("success");
              void reload();
            }}
            provider={provider}
            workspaces={workspaces}
          />
        ) : null}

        {view === "setup" && provider ? (
          <form className="section" onSubmit={(event) => void connect(event)}>
            <SetupProgress provider={provider} step={step} />
            {step === 0 ? (
              <ProviderCredentials
                draft={draft}
                onOpenError={(reason) => setError(message(reason))}
                provider={provider}
                setDraft={setDraft}
              />
            ) : null}
            {step === 1 ? (
              <ChannelDestination
                draft={draft}
                provider={provider}
                setDraft={setDraft}
                workspaces={workspaces}
              />
            ) : null}
            {step === 2 ? (
              <ChannelAccess draft={draft} provider={provider} setDraft={setDraft} />
            ) : null}
            {step === 3 ? (
              <ChannelReview
                draft={draft}
                provider={provider}
                routeSummary={routeSummary}
                {...(workspace ? { workspaceName: workspace.name } : {})}
              />
            ) : null}
            <div className="form-actions">
              {error ? (
                <span aria-live="assertive" className="form-actions__error" role="alert">
                  {error}
                </span>
              ) : null}
              <button
                className="btn"
                disabled={pending}
                onClick={() => {
                  if (step === 0) setView("providers");
                  else setStep((current) => current - 1);
                }}
                type="button"
              >
                Back
              </button>
              <button className="btn btn--primary" disabled={!canContinue || pending} type="submit">
                {pending ? "Checking…" : step === 3 ? `Connect ${provider.label}` : "Continue"}
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
                onClick={() => void checkRepair()}
                type="button"
              >
                Check again
              </button>
              <button
                className="btn btn--primary"
                disabled={
                  pending ||
                  !provider.credentialFields.every(({ key }) => draft.credentials[key]?.trim())
                }
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
            directMessages={draft.accessPolicy.directMessages.mode}
            onDone={() => {
              setCreated(null);
              setView("overview");
            }}
            providerLabel={provider?.label ?? "Messaging provider"}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The landing view: the link field, then every connection this person owns. */
export function ChannelOverview({
  dashboard,
  error,
  homeWorkspaceId,
  linkError,
  linked,
  onAdd,
  onAddRoute,
  onCheck,
  onLink,
  onRepair,
  onReviewAccess,
  onRevoke,
  onRevokeRoute,
  onStatus,
  onUpdateAccess,
  pending,
  workspaces,
}: {
  dashboard: ChannelDashboard | null;
  error: string | null;
  homeWorkspaceId: string;
  linkError: string | null;
  linked: LinkedIdentity | null;
  onAdd: () => void;
  onAddRoute: (account: ChannelAccount, route: RouteDraft) => Promise<boolean>;
  onCheck: (connectionId: string, displayName: string) => void;
  onLink: (code: string) => Promise<boolean>;
  onRepair: (connectionId: string, provider: string) => void;
  onReviewAccess: (
    grant: ChannelDashboard["accessGrants"][number],
    decision: "approved" | "declined" | "revoked",
  ) => void;
  onRevoke: (connectionId: string) => void;
  onRevokeRoute: (bindingId: ChannelBinding["id"]) => void;
  onStatus: (connectionId: string, status: "connected" | "paused") => void;
  onUpdateAccess: (binding: ChannelBinding, accessPolicy: ChannelAccessPolicy) => Promise<boolean>;
  pending: boolean;
  workspaces: readonly WorkspaceSummary[];
}) {
  if (!dashboard && !error)
    return (
      <div className="section">
        <span className="section__hint">
          <span className="spinner" role="status" aria-label="Loading" /> Loading connected
          channels…
        </span>
      </div>
    );
  const providerReady = dashboard?.providers.some(
    ({ availability }) => availability === "available",
  );
  return (
    <>
      {dashboard && !providerReady ? (
        <p className="notice notice--warn">
          Messaging connections are starting. Opensteer will make providers available when the
          service is ready.
        </p>
      ) : null}
      {dashboard?.deliveriesNeedingAttention ? (
        <p className="notice notice--warn">
          {dashboard.deliveriesNeedingAttention} deliveries need review. Open this deployment’s logs
          before retrying messages with an unknown outcome.
        </p>
      ) : null}
      {error ? (
        <p aria-live="assertive" className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      {dashboard?.accessGrants.length ? (
        <AccessRequests
          accounts={dashboard.accounts}
          grants={dashboard.accessGrants}
          onReview={onReviewAccess}
          pending={pending}
        />
      ) : null}
      {/*
       * The dashboard lists only the connections this person owns, so a teammate
       * who was handed a code has no account card to stand under. The field is
       * always here; the Host answers `not_found` for a code that is not theirs.
       */}
      <LinkIdentityForm error={linkError} linked={linked} onLink={onLink} pending={pending} />
      <section className="section">
        <div className="section__head">
          <div>
            <h2 className="section__title">Messaging identities</h2>
            <p className="section__hint">
              Give a Workspace its own bot, or route one shared bot to several Workspaces.
            </p>
          </div>
          <button
            className="btn btn--primary btn--small"
            disabled={!providerReady}
            onClick={onAdd}
            type="button"
          >
            <Icon name="plus" /> Add identity
          </button>
        </div>
        <div className="card">
          {dashboard?.connections.length ? (
            dashboard.connections.map((connection) => {
              const accounts = dashboard.accounts.filter(
                ({ connectionId }) => connectionId === connection.id,
              );
              const routingMode = accounts[0]?.routingMode ?? "shared";
              const provider = dashboard.providers.find(
                ({ provider }) => provider === connection.provider,
              );
              // A channel on one of your computers is fixed on that computer and
              // resumes by itself; there are no credentials here to replace.
              const repairable =
                connection.status === "needs-attention" && connection.transportKind !== "computer";
              return (
                <Fragment key={connection.id}>
                  <div className="card__row">
                    <span className="card__row-glyph" aria-hidden="true">
                      {(provider?.label ?? connection.provider).slice(0, 1).toUpperCase()}
                    </span>
                    <div className="card__row-body">
                      <span className="card__row-title">
                        {connection.displayName}
                        <span className={`chip ${statusChip(connection.status)}`}>
                          {statusLabel(connection.status)}
                        </span>
                      </span>
                      <span className="card__row-detail">
                        {provider?.label ?? connection.provider} ·{" "}
                        {connection.transportKind === "computer"
                          ? "On your Mac"
                          : connection.connectionMethod === "managed-oauth"
                            ? "Managed connection"
                            : "Your provider app"}
                        {routingMode === "dedicated" ? " · Dedicated bot" : " · Shared bot"}
                      </span>
                      {connection.statusDetail ? (
                        <span className="card__row-detail">{connection.statusDetail}</span>
                      ) : null}
                    </div>
                    <div className="card__row-actions">
                      <button
                        aria-label={`Check ${connection.displayName}`}
                        className="icon-btn"
                        disabled={pending}
                        onClick={() => onCheck(connection.id, connection.displayName)}
                        type="button"
                      >
                        <Icon name="reload" />
                      </button>
                      <button
                        className="btn btn--small"
                        disabled={pending}
                        onClick={() => {
                          if (repairable) onRepair(connection.id, connection.provider);
                          else
                            onStatus(
                              connection.id,
                              connection.status === "paused" ? "connected" : "paused",
                            );
                        }}
                        type="button"
                      >
                        {repairable
                          ? "Fix setup"
                          : connection.status === "paused"
                            ? "Resume"
                            : "Pause"}
                      </button>
                      <button
                        aria-label={`Revoke ${connection.displayName}`}
                        className="icon-btn"
                        disabled={pending}
                        onClick={() => onRevoke(connection.id)}
                        type="button"
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </div>
                  {accounts.map((account) => (
                    <AccountRoutes
                      account={account}
                      bindings={dashboard.bindings.filter(
                        ({ accountId }) => accountId === account.id,
                      )}
                      homeWorkspaceId={homeWorkspaceId}
                      key={account.id}
                      onAddRoute={onAddRoute}
                      onRevokeRoute={onRevokeRoute}
                      onUpdateAccess={onUpdateAccess}
                      pending={pending}
                      providerLabel={provider?.label ?? connection.provider}
                      workspaces={workspaces}
                    />
                  ))}
                </Fragment>
              );
            })
          ) : (
            <div className="card__empty">
              <p>Connect a bot to use Opensteer from your team’s conversations.</p>
              <button
                className="btn btn--primary"
                disabled={!providerReady}
                onClick={onAdd}
                type="button"
              >
                Connect a messaging app
              </button>
            </div>
          )}
        </div>
      </section>
    </>
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
          <div className="card__empty">
            No messaging providers are available on this deployment yet.
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SetupProgress({ provider, step }: { provider: ChannelProviderManifest; step: number }) {
  return (
    <div aria-label={`${provider.label} setup progress`} className="wizard-steps">
      {[provider.label, "Where it answers", "Who can use it", "Review"].map((label, index) => (
        <Fragment key={label}>
          {index > 0 ? <Icon name="chevron-right" /> : null}
          <span className={index === step ? "wizard-steps__step--active" : undefined}>
            {index < step ? <Icon name="check" /> : null} {label}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function ProviderCredentials({
  draft,
  onOpenError,
  provider,
  setDraft,
}: DraftProps & {
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
                    void navigator.clipboard.writeText(content).then(() => {
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
        <p className="notice">Credentials are encrypted and never enter agent context.</p>
      </div>
    </div>
  );
}

function ChannelDestination({
  draft,
  setDraft,
  workspaces,
}: DraftProps & {
  provider: ChannelProviderManifest;
  workspaces: readonly WorkspaceSummary[];
}) {
  return (
    <div className="card">
      <div className="card__form">
        <p className="section__hint">Choose the Workspace this bot represents.</p>
        <label className="field">
          <span className="field__label">Opensteer Workspace</span>
          <select
            className="select-input"
            onChange={(event) => setDraft({ ...draft, workspaceId: event.currentTarget.value })}
            value={draft.workspaceId}
          >
            {workspaces
              .filter(({ status }) => status === "ready")
              .map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
          </select>
        </label>
        <div className="check-list" role="radiogroup" aria-label="Bot role">
          <label className="check-item">
            <input
              checked={draft.routingMode === "dedicated"}
              name="channel-routing-mode"
              onChange={() => setDraft({ ...draft, routingMode: "dedicated" })}
              type="radio"
            />
            <span className="check-item__meta">
              <span className="check-item__label">
                Dedicated Workspace bot <span className="chip chip--accent">Recommended</span>
              </span>
              <span className="check-item__detail">
                This identity always represents the selected Workspace.
              </span>
            </span>
          </label>
          <label className="check-item">
            <input
              checked={draft.routingMode === "shared"}
              name="channel-routing-mode"
              onChange={() => setDraft({ ...draft, routingMode: "shared" })}
              type="radio"
            />
            <span className="check-item__meta">
              <span className="check-item__label">Shared bot with routes</span>
              <span className="check-item__detail">
                Reuse this identity for more Workspaces. You can add routes after setup.
              </span>
            </span>
          </label>
        </div>
        <p className="notice notice--accent">
          New conversations start Opensteer threads in{" "}
          {workspaces.find(({ id }) => id === draft.workspaceId)?.name ?? "this Workspace"}.
        </p>
      </div>
    </div>
  );
}

function ChannelAccess({
  draft,
  provider,
  setDraft,
}: DraftProps & { provider: ChannelProviderManifest }) {
  return (
    <div className="card">
      <AccessPolicyEditor
        channelInput={draft.channelInput}
        onChange={(accessPolicy, channelInput) =>
          setDraft({ ...draft, accessPolicy, channelInput })
        }
        policy={draft.accessPolicy}
        providerLabel={provider.label}
      />
    </div>
  );
}

function ChannelReview({
  draft,
  provider,
  routeSummary,
  workspaceName,
}: {
  draft: ChannelDraft;
  provider: ChannelProviderManifest;
  routeSummary: string;
  workspaceName?: string;
}) {
  const rows: { detail: string; title: string }[] = [
    { detail: `${provider.label} · verified on connect`, title: "Connected account" },
    {
      detail:
        draft.routingMode === "dedicated" ? "Dedicated Workspace bot" : "Shared bot with routes",
      title: "Bot role",
    },
    { detail: `${workspaceName ?? "Workspace"} — ${routeSummary}`, title: "Where it answers" },
    {
      detail: channelPolicySummary(
        accessPolicyFromDraft(draft.accessPolicy, draft.channelInput),
        provider.label,
      ),
      title: "Channels",
    },
    { detail: senderLabel(draft.accessPolicy.directMessages.mode), title: "Direct messages" },
    {
      detail:
        draft.accessPolicy.channels.sender.mode === "linked-members" ||
        draft.accessPolicy.directMessages.mode === "linked-members"
          ? "Linked members use their own access; other admitted senders use yours."
          : `Runs started from ${provider.label} use your Opensteer access.`,
      title: "Authority",
    },
    { detail: "Default AI engine", title: "Runs on" },
  ];
  return (
    <div className="card">
      {rows.map((row) => (
        <div className="card__row" key={row.title}>
          <div className="card__row-body">
            <span className="card__row-title">{row.title}</span>
            <span className="card__row-detail">{row.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConnectionSuccess({
  connection,
  directMessages,
  onDone,
  providerLabel,
}: {
  connection: CreatedChannelConnection["connection"];
  directMessages: SenderMode;
  onDone: () => void;
  providerLabel: string;
}) {
  return (
    <section className="section">
      {connection.status === "connected" ? (
        <p className="notice notice--accent">
          Opensteer verified the {providerLabel} account and its messaging transport is connected.
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
          <span className="card__row-glyph" aria-hidden="true">
            <Icon name="message" />
          </span>
          <div className="card__row-body">
            <span className="card__row-title">Invite the bot where it should work</span>
            <span className="card__row-detail">
              Add the provider app to any channels where people will mention it.
            </span>
          </div>
        </div>
        {directMessages === "owner" ? (
          <div className="card__row">
            <span className="card__row-glyph" aria-hidden="true">
              <Icon name="check" />
            </span>
            <div className="card__row-body">
              <span className="card__row-title">Verify your direct messages</span>
              <span className="card__row-detail">
                Message the bot once. It sends an 8-character code that you can enter on this page
                to confirm which {providerLabel} account is yours.
              </span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="form-actions">
        <button className="btn btn--primary" onClick={onDone} type="button">
          Done
        </button>
      </div>
    </section>
  );
}

/**
 * The code travels bot → person → this field, so what is typed here is read
 * from a chat message: fold case and drop the characters the alphabet omits
 * rather than refusing the paste.
 */
export function normalizeLinkCode(value: string): string {
  return [...value.toUpperCase()]
    .filter((character) => linkCodeAlphabet.includes(character))
    .join("")
    .slice(0, linkCodeLength);
}

export function LinkIdentityForm({
  error,
  linked,
  onLink,
  pending,
}: {
  error: string | null;
  linked: LinkedIdentity | null;
  onLink: (code: string) => Promise<boolean>;
  pending: boolean;
}) {
  const [code, setCode] = useState("");
  return (
    <section className="section">
      <div className="section__head">
        <div>
          <h2 className="section__title">Link a messaging account</h2>
          <p className="section__hint">
            Got a code from a bot? Enter it here to link that messaging account to you.
          </p>
        </div>
      </div>
      <div className="card">
        <form
          className="card__form"
          onSubmit={(event) => {
            event.preventDefault();
            void onLink(code).then((spent) => {
              if (spent) setCode("");
            });
          }}
        >
          <label className="field">
            <span className="field__label">Code from the bot</span>
            <input
              autoComplete="off"
              className="text-input"
              maxLength={linkCodeLength}
              onChange={(event) => setCode(normalizeLinkCode(event.currentTarget.value))}
              placeholder="ABCD2345"
              spellCheck={false}
              value={code}
            />
            <span className="field__hint">
              Eight characters. Codes expire an hour after the bot sends them.
            </span>
          </label>
          {linked ? (
            <p className="notice notice--accent">
              Linked {linked.displayName} on {linked.providerLabel}.
            </p>
          ) : null}
          <div className="form-actions">
            {error ? (
              <span aria-live="assertive" className="form-actions__error" role="alert">
                {error}
              </span>
            ) : null}
            <button
              className="btn btn--primary btn--small"
              disabled={pending || code.length !== linkCodeLength}
              type="submit"
            >
              Link account
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

export function AccessRequests({
  accounts,
  grants,
  onReview,
  pending,
}: {
  accounts: readonly ChannelAccount[];
  grants: ChannelDashboard["accessGrants"];
  onReview: (
    grant: ChannelDashboard["accessGrants"][number],
    decision: "approved" | "declined" | "revoked",
  ) => void;
  pending: boolean;
}) {
  const pendingGrants = grants.filter(({ status }) => status === "pending");
  const decidedGrants = grants.filter(({ status }) => status !== "pending");
  return (
    <section className="section channel-access-inbox">
      <div className="section__head">
        <div>
          <h2 className="section__title">Access requests</h2>
          <p className="section__hint">Requests stay here until you approve or decline them.</p>
        </div>
        {pendingGrants.length ? (
          <span className="chip chip--accent">{pendingGrants.length} new</span>
        ) : null}
      </div>
      <div className="card">
        {pendingGrants.map((grant) => (
          <div className="card__row" key={`${grant.bindingId}:${grant.externalUserId}`}>
            <span className="card__row-glyph" aria-hidden="true">
              <Icon name="message" />
            </span>
            <div className="card__row-body">
              <span className="card__row-title">{grant.displayName}</span>
              <span className="card__row-detail">{grant.externalUserId}</span>
              <span className="card__row-detail">
                {accounts.find(({ id }) => id === grant.accountId)?.displayName ??
                  "Messaging account"}
                {" · "}
                {new Date(grant.requestedAt).toLocaleDateString()}
              </span>
            </div>
            <div className="card__row-actions">
              <button
                className="btn btn--small"
                disabled={pending}
                onClick={() => onReview(grant, "declined")}
                type="button"
              >
                Decline
              </button>
              <button
                className="btn btn--primary btn--small"
                disabled={pending}
                onClick={() => onReview(grant, "approved")}
                type="button"
              >
                Approve
              </button>
            </div>
          </div>
        ))}
        {decidedGrants.length ? (
          <details className="channel-access-history">
            <summary>Previous decisions ({decidedGrants.length})</summary>
            {decidedGrants.map((grant) => (
              <div className="card__row" key={`${grant.bindingId}:${grant.externalUserId}`}>
                <div className="card__row-body">
                  <span className="card__row-title">{grant.displayName}</span>
                  <span className="card__row-detail">{grant.externalUserId}</span>
                  <span className="card__row-detail">
                    {grant.externalUserId} · {statusLabel(grant.status)}
                  </span>
                </div>
                {grant.status === "approved" ? (
                  <button
                    className="btn btn--small"
                    disabled={pending}
                    onClick={() => onReview(grant, "revoked")}
                    type="button"
                  >
                    Revoke
                  </button>
                ) : (
                  <button
                    className="btn btn--small"
                    disabled={pending}
                    onClick={() => onReview(grant, "approved")}
                    type="button"
                  >
                    Approve
                  </button>
                )}
              </div>
            ))}
          </details>
        ) : null}
      </div>
    </section>
  );
}

export function AccessPolicyEditor({
  channelInput,
  onChange,
  policy,
  providerLabel,
}: {
  channelInput: string;
  onChange: (policy: ChannelAccessPolicy, channelInput: string) => void;
  policy: ChannelAccessPolicy;
  providerLabel: string;
}) {
  return (
    <div className="card__form channel-access-editor">
      <div className="channel-access-editor__group">
        <div className="channel-access-editor__heading">
          <span className="field__label">Channels</span>
          <span className="field__hint">Choose where people can mention the bot.</span>
        </div>
        <label className="field">
          <span className="sr-only">Channel reach</span>
          <select
            aria-label="Channel reach"
            className="select-input"
            onChange={(event) => {
              const scope = channelScope(event.currentTarget.value);
              onChange({ ...policy, channels: { ...policy.channels, scope } }, channelInput);
            }}
            value={policy.channels.scope}
          >
            <option value="selected">Selected channels</option>
            <option value="all">All channels where the bot is invited</option>
            <option value="off">Off</option>
          </select>
        </label>
        {policy.channels.scope === "selected" ? (
          <label className="field">
            <span className="field__label">{providerLabel} channel link or ID</span>
            <textarea
              className="text-input"
              onBlur={(event) => {
                const normalized = normalizeChannelIds(event.currentTarget.value).join("\n");
                onChange(policy, normalized);
              }}
              onChange={(event) => onChange(policy, event.currentTarget.value)}
              placeholder={"https://workspace.slack.com/archives/C0123ABC\nC0456DEF"}
              required
              rows={3}
              value={channelInput}
            />
            <span className="field__hint">Paste links or IDs, one per line.</span>
          </label>
        ) : null}
        {policy.channels.scope !== "off" ? (
          <label className="field">
            <span className="field__label">Who can mention it</span>
            <select
              className="select-input"
              onChange={(event) =>
                onChange(
                  {
                    ...policy,
                    channels: {
                      ...policy.channels,
                      sender: {
                        ...policy.channels.sender,
                        mode: senderMode(event.currentTarget.value),
                      },
                    },
                  },
                  channelInput,
                )
              }
              value={policy.channels.sender.mode}
            >
              <SenderOptions />
            </select>
          </label>
        ) : null}
      </div>
      <div className="channel-access-editor__group">
        <div className="channel-access-editor__heading">
          <span className="field__label">Direct messages</span>
          <span className="field__hint">Kept separate from shared channel access.</span>
        </div>
        <label className="field">
          <span className="sr-only">Who can send direct messages</span>
          <select
            aria-label="Who can send direct messages"
            className="select-input"
            onChange={(event) =>
              onChange(
                {
                  ...policy,
                  directMessages: {
                    ...policy.directMessages,
                    mode: senderMode(event.currentTarget.value),
                  },
                },
                channelInput,
              )
            }
            value={policy.directMessages.mode}
          >
            <SenderOptions />
          </select>
        </label>
      </div>
      {policy.channels.sender.allowedExternalUserIds.length > 0 ||
      policy.directMessages.allowedExternalUserIds.length > 0 ? (
        <details className="channel-access-editor__restrictions">
          <summary>Existing user restrictions</summary>
          {(["channels", "directMessages"] as const).map((surface) => {
            const sender = surface === "channels" ? policy.channels.sender : policy.directMessages;
            if (sender.allowedExternalUserIds.length === 0) return null;
            return (
              <label className="field" key={surface}>
                <span className="field__label">
                  {surface === "channels" ? "Channel" : "Direct message"} user IDs
                </span>
                <textarea
                  className="text-input"
                  rows={2}
                  value={sender.allowedExternalUserIds.join("\n")}
                  onChange={(event) => {
                    const next = {
                      ...sender,
                      allowedExternalUserIds: event.currentTarget.value
                        .split(/[\s,]+/u)
                        .filter(Boolean),
                    };
                    onChange(
                      surface === "channels"
                        ? { ...policy, channels: { ...policy.channels, sender: next } }
                        : { ...policy, directMessages: next },
                      channelInput,
                    );
                  }}
                />
                <span className="field__hint">
                  Only these people are eligible. Clear the list to remove this extra restriction.
                </span>
              </label>
            );
          })}
        </details>
      ) : null}
      <p className="notice notice--accent">
        {policy.channels.sender.mode === "linked-members" ||
        policy.directMessages.mode === "linked-members"
          ? "Linked members run with their own Opensteer access. Other admitted senders use the connection owner’s access."
          : `Runs started from ${providerLabel} use the connection owner’s Opensteer access.`}
      </p>
    </div>
  );
}

function SenderOptions() {
  return (
    <>
      <option value="anyone">Anyone</option>
      <option value="owner">Only me</option>
      <option value="approved">Ask for access</option>
      <option value="off">Off</option>
      <option value="linked-members">Linked Opensteer members (advanced)</option>
    </>
  );
}

/** One account's routes, and the form that adds another. */
export function AccountRoutes({
  account,
  bindings,
  homeWorkspaceId,
  onAddRoute,
  onRevokeRoute,
  onUpdateAccess,
  pending,
  providerLabel,
  workspaces,
}: {
  account: ChannelAccount;
  bindings: readonly ChannelBinding[];
  homeWorkspaceId: string;
  onAddRoute: (account: ChannelAccount, route: RouteDraft) => Promise<boolean>;
  onRevokeRoute: (bindingId: ChannelBinding["id"]) => void;
  onUpdateAccess: (binding: ChannelBinding, accessPolicy: ChannelAccessPolicy) => Promise<boolean>;
  pending: boolean;
  providerLabel: string;
  workspaces: readonly WorkspaceSummary[];
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<ChannelBinding["id"] | null>(null);
  const [editing, setEditing] = useState<ChannelBinding["id"] | null>(null);
  const [editPolicy, setEditPolicy] = useState<ChannelAccessPolicy | null>(null);
  const [editChannels, setEditChannels] = useState("");
  const [route, setRoute] = useState<RouteDraft>({
    accessPolicy: channelRouteAccessPolicy(),
    conversationId: "",
    workspaceId: homeWorkspaceId,
  });
  /** A dedicated bot is one identity for one Workspace: the Host refuses a second binding. */
  const dedicated = account.routingMode === "dedicated";
  return (
    <>
      {bindings.map((binding) => (
        <Fragment key={binding.id}>
          <div className="card__row">
            <span className="card__row-glyph" aria-hidden="true">
              <Icon name="workspace" />
            </span>
            <div className="card__row-body">
              <span className="card__row-title">
                {workspaces.find(({ id }) => id === binding.workspaceId)?.name ?? "Workspace"}
                {binding.status === "active" ? null : (
                  <span className="chip">{statusLabel(binding.status)}</span>
                )}
              </span>
              <span className="card__row-detail">
                {routeSelectorLabel(binding.selector)} ·{" "}
                {channelPolicySummary(binding.accessPolicy, providerLabel)}
              </span>
              <span className="card__row-detail">
                Direct messages: {senderLabel(binding.accessPolicy.directMessages.mode)}
                {binding.accessPolicy.directMessages.allowedExternalUserIds.length > 0
                  ? ` · ${binding.accessPolicy.directMessages.allowedExternalUserIds.length} eligible users`
                  : ""}
              </span>
            </div>
            {binding.status === "revoked" ? null : (
              <div className="card__row-actions">
                {confirming === binding.id ? (
                  <>
                    <span className="card__row-detail">Stop routing this conversation?</span>
                    <button
                      className="btn btn--small"
                      disabled={pending}
                      onClick={() => setConfirming(null)}
                      type="button"
                    >
                      Keep
                    </button>
                    <button
                      className="btn btn--danger btn--small"
                      disabled={pending}
                      onClick={() => {
                        setConfirming(null);
                        onRevokeRoute(binding.id);
                      }}
                      type="button"
                    >
                      Remove route
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn btn--small"
                      disabled={pending}
                      onClick={() => {
                        setEditing(binding.id);
                        setEditPolicy(binding.accessPolicy);
                        setEditChannels(binding.accessPolicy.channels.conversationIds.join("\n"));
                      }}
                      type="button"
                    >
                      Access
                    </button>
                    <button
                      className="btn btn--small"
                      disabled={pending}
                      onClick={() => setConfirming(binding.id)}
                      type="button"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {editing === binding.id && editPolicy ? (
            <form
              className="channel-route-editor"
              onSubmit={(event) => {
                event.preventDefault();
                const accessPolicy = accessPolicyFromDraft(editPolicy, editChannels);
                void onUpdateAccess(binding, accessPolicy).then((updated) => {
                  if (updated) setEditing(null);
                });
              }}
            >
              <AccessPolicyEditor
                channelInput={editChannels}
                onChange={(policy, channelInput) => {
                  setEditPolicy(policy);
                  setEditChannels(channelInput);
                }}
                policy={editPolicy}
                providerLabel={providerLabel}
              />
              <div className="form-actions channel-route-editor__actions">
                <button className="btn btn--small" onClick={() => setEditing(null)} type="button">
                  Cancel
                </button>
                <button
                  className="btn btn--primary btn--small"
                  disabled={
                    pending ||
                    (editPolicy.channels.scope === "selected" &&
                      normalizeChannelIds(editChannels).length === 0)
                  }
                  type="submit"
                >
                  Save access
                </button>
              </div>
            </form>
          ) : null}
        </Fragment>
      ))}
      <div className="card__row">
        <div className="card__row-body">
          <span className="card__row-detail">
            {dedicated
              ? `A dedicated bot has one route. Connect another ${providerLabel} identity to answer for another Workspace.`
              : bindings.length
                ? `${bindings.length} route${bindings.length === 1 ? "" : "s"} for ${account.displayName}.`
                : `No routes yet for ${account.displayName}. Messages reach Opensteer only where a route matches.`}
          </span>
        </div>
        {dedicated ? null : (
          <div className="card__row-actions">
            <button
              className="btn btn--small"
              disabled={pending}
              onClick={() => setOpen((current) => !current)}
              type="button"
            >
              {open ? "Cancel" : "Add route"}
            </button>
          </div>
        )}
      </div>
      {open ? (
        <form
          className="card__form"
          onSubmit={(event) => {
            event.preventDefault();
            void onAddRoute(account, route).then((created) => {
              if (!created) return;
              setOpen(false);
              setRoute({ ...route, conversationId: "" });
            });
          }}
        >
          <label className="field">
            <span className="field__label">{providerLabel} channel link or ID</span>
            <input
              autoComplete="off"
              autoFocus
              className="text-input"
              maxLength={512}
              onChange={(event) =>
                setRoute({ ...route, conversationId: event.currentTarget.value })
              }
              onBlur={(event) => {
                const normalized = normalizeChannelIds(event.currentTarget.value)[0];
                if (normalized) setRoute({ ...route, conversationId: normalized });
              }}
              placeholder="https://workspace.slack.com/archives/C0123ABC"
              required
              value={route.conversationId}
            />
            <span className="field__hint">Paste the channel link, or its provider ID.</span>
          </label>
          <label className="field">
            <span className="field__label">Opensteer Workspace</span>
            <select
              className="select-input"
              onChange={(event) => setRoute({ ...route, workspaceId: event.currentTarget.value })}
              value={route.workspaceId}
            >
              {workspaces
                .filter(({ status }) => status === "ready")
                .map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Who can mention it</span>
            <select
              className="select-input"
              onChange={(event) =>
                setRoute({
                  ...route,
                  accessPolicy: {
                    ...route.accessPolicy,
                    channels: {
                      ...route.accessPolicy.channels,
                      sender: {
                        ...route.accessPolicy.channels.sender,
                        mode: senderMode(event.currentTarget.value),
                      },
                    },
                  },
                })
              }
              value={route.accessPolicy.channels.sender.mode}
            >
              <SenderOptions />
            </select>
          </label>
          <div className="form-actions">
            <button
              className="btn btn--primary btn--small"
              disabled={pending || !route.conversationId.trim() || !route.workspaceId}
              type="submit"
            >
              Add route
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}

type DraftProps = { draft: ChannelDraft; setDraft: (draft: ChannelDraft) => void };

function heading(view: View, step: number, providerLabel = "provider"): string {
  if (view === "overview") return "Reach your agents anywhere";
  if (view === "providers") return "Add a messaging identity";
  if (view === "success") return `${providerLabel} connection saved`;
  if (view === "repair") return `Fix ${providerLabel} setup`;
  return (
    [`Connect ${providerLabel}`, "Choose a destination", "Set access", "Review the route"][step] ??
    `Connect ${providerLabel}`
  );
}

function subheading(view: View, step: number, providerLabel = "provider"): string {
  if (view === "overview")
    return "Connect messaging accounts and route each conversation to the right Workspace.";
  if (view === "providers")
    return "Provider adapters stay outside the agent runtime, so agents remain lean.";
  if (view === "success") return "Review the connection status and finish the provider-side steps.";
  if (view === "repair")
    return "Finish any provider-side changes, check again, or replace the saved credentials.";
  if (view === "computer-setup") return "Your agents answer from one of your own Macs.";
  return (
    [
      `For a self-hosted deployment, bring a ${providerLabel} app you control.`,
      "Choose a dedicated Workspace identity or an advanced shared route.",
      "Choose channel access and direct messages.",
      `You can add more specific routes later without reconnecting ${providerLabel}.`,
    ][step] ?? ""
  );
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

function statusLabel(status: string): string {
  return status === "connected"
    ? "Connected"
    : status === "needs-attention"
      ? "Needs attention"
      : status[0]?.toUpperCase() + status.slice(1);
}

function providerLabelFor(dashboard: ChannelDashboard | null, provider: string): string {
  return (
    dashboard?.providers.find(({ provider: candidate }) => candidate === provider)?.label ??
    provider
  );
}

function routeSelectorLabel(selector: ChannelRouteSelector): string {
  const parts = [
    selector.conversationId ? `Channel ${selector.conversationId}` : "DMs and mentions",
    ...(selector.conversationType ? [selector.conversationType] : []),
    ...(selector.scopeId ? [`Scope ${selector.scopeId}`] : []),
    ...(selector.threadId ? [`Thread ${selector.threadId}`] : []),
  ];
  return parts.join(" · ");
}

function defaultChannelAccessPolicy(): ChannelAccessPolicy {
  return {
    channels: {
      conversationIds: [],
      scope: "selected",
      sender: { allowedExternalUserIds: [], mode: "anyone" },
    },
    directMessages: { allowedExternalUserIds: [], mode: "owner" },
  };
}

function channelRouteAccessPolicy(): ChannelAccessPolicy {
  return {
    channels: {
      conversationIds: [],
      scope: "selected",
      sender: { allowedExternalUserIds: [], mode: "anyone" },
    },
    directMessages: { allowedExternalUserIds: [], mode: "off" },
  };
}

function senderMode(value: string): SenderMode {
  return senderModes.find((candidate) => candidate === value) ?? "off";
}

function channelScope(value: string): ChannelAccessPolicy["channels"]["scope"] {
  return value === "all" || value === "off" ? value : "selected";
}

function senderLabel(mode: SenderMode): string {
  return mode === "linked-members"
    ? "Linked Opensteer members"
    : mode === "owner"
      ? "Only me"
      : mode === "approved"
        ? "Ask for access"
        : mode === "anyone"
          ? "Anyone"
          : "Off";
}

function accessPolicyFromDraft(
  policy: ChannelAccessPolicy,
  channelInput: string,
): ChannelAccessPolicy {
  return {
    ...policy,
    channels: {
      ...policy.channels,
      conversationIds:
        policy.channels.scope === "selected" ? normalizeChannelIds(channelInput) : [],
    },
  };
}

function channelPolicySummary(policy: ChannelAccessPolicy, providerLabel: string): string {
  if (policy.channels.scope === "off") return "Channel mentions off";
  const reach =
    policy.channels.scope === "all"
      ? `All ${providerLabel} channels where invited`
      : `${policy.channels.conversationIds.length} selected channel${
          policy.channels.conversationIds.length === 1 ? "" : "s"
        }`;
  return `${reach} · ${senderLabel(policy.channels.sender.mode)}${policy.channels.sender.allowedExternalUserIds.length > 0 ? ` · ${policy.channels.sender.allowedExternalUserIds.length} eligible users` : ""}`;
}

/** Accepts provider IDs and Slack channel URLs, deduplicating while preserving order. */
export function normalizeChannelIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map((item) => item.trim())
        .map((item) => {
          const fromSlackUrl = item.match(/\/archives\/([A-Za-z0-9_-]+)/u)?.[1];
          return fromSlackUrl ?? item;
        })
        .map((item) => item.replace(/[?#].*$/u, ""))
        .filter(Boolean),
    ),
  ];
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Channel settings could not be loaded.";
}
