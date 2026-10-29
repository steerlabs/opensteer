import type {
  ComputerAppIdentity,
  ComputerUseAppApproval,
  IntegrationAccess,
} from "@opensteer/integration-core";
import type { DesktopOpenComputerUsePermissionsPanelResult } from "@opensteer/protocol/desktop";
import type {
  ComputerUseInstalledApp,
  ComputerUseSessionSummary,
  MachineSummary,
} from "@opensteer/protocol";
import {
  askForEachComputerUseApp,
  cancelComputerUseSetup,
  computerUseApprovalKeyStep,
  computerUseAccessLabel,
  computerUseAppApprovalDetail,
  computerUseAppApprovalLabel,
  computerUseAppApprovalsTitle,
  computerUseApproveOn,
  computerUseAutomaticFootnote,
  computerUseConfirmOnThisMac,
  computerUseFirstRun,
  computerUseGrantLabel,
  computerUseGrantOrder,
  computerUseGrantPurpose,
  computerUseHelperName,
  computerUseInstallOn,
  computerUseIntroduction,
  computerUsePendingAction,
  computerUseSessionTitle,
  computerUseSetUpFrom,
  computerUseSetUpFromSteps,
  computerUseSetupQuestion,
  computerUseStatusLine,
  computerUseTakeBack,
  computerUseTone,
  computerUseTurnOnFrom,
  computerUseUnblockOn,
  computerUseWhere,
  computerUseStops,
  takeBackComputerUseApp,
  type ComputerUseAppRow,
  type ComputerUseGrant,
  type ComputerUsePendingApp,
  type ComputerUseTone,
  type ComputerUseView,
  type ComputerUseViewer,
} from "@opensteer/client/integrations";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { useComputerUseStop } from "@opensteer/client/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { actionErrorMessage } from "../../ui-utils.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { useAppIcon } from "./app-icons.js";

/**
 * What the desktop on the Mac itself can do that no other client can: show the
 * macOS permission panel, and ask the person at the keyboard about a setup
 * request in its own window, which signs and records the answer. Presence is
 * presentation; every callback is still authorized server-side.
 */
export interface ComputerUseLocalActions {
  readonly openPermissions: () => Promise<DesktopOpenComputerUsePermissionsPanelResult>;
  /** Shows the native approval for a setup request just created; true when allowed. */
  readonly reviewSetup: (setupRequestId: string) => Promise<boolean>;
}

export interface ComputerUseApprovalKeySetup {
  readonly error: string | null;
  readonly ready: boolean;
  readonly retry: () => void;
}

/** A failed action and the key of what it was acting on, so the error sits there. */
type Failure = { readonly key: string; readonly message: string };

/** How many installed apps one page of the picker asks the Mac for. */
const pickerPageSize = 50;
/** Long enough that typing a name is one question to the Mac, not one per key. */
const pickerSearchDelayMs = 200;

/**
 * The Computer use block of "Apps agents can use": one Mac, the apps agents
 * may see or operate on it, and what is happening there right now.
 *
 * It is one card row group rather than one row per app because the thing a
 * person turns on is computer use on this Mac; apps are what they approve
 * inside it. The header is the block's whole state at a glance, and each
 * state has exactly one next action.
 */
export function ComputerUseBlock({
  approvalKeySetup = null,
  hostClient,
  local,
  machine,
  onChanged,
  owned,
  view,
}: {
  readonly approvalKeySetup?: ComputerUseApprovalKeySetup | null;
  readonly hostClient: HostClient;
  readonly local: ComputerUseLocalActions | null;
  readonly machine: MachineSummary;
  readonly onChanged: () => Promise<void>;
  readonly owned: boolean;
  readonly view: ComputerUseView;
}) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const acting = useRef(false);

  async function run(key: string, operation: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(key);
    setFailure(null);
    try {
      await operation();
      // A failed reload after a successful mutation does not undo the change.
      await onChanged().catch(() => undefined);
    } catch (reason) {
      setFailure({ key, message: actionErrorMessage(reason) });
    } finally {
      acting.current = false;
      setBusy(null);
    }
  }

  /** One app, one access: the Host issues the request and this Mac asks about it. */
  async function askOnThisMac(
    actions: ComputerUseLocalActions,
    input: { readonly access: IntegrationAccess; readonly app: ComputerAppIdentity },
  ): Promise<void> {
    const result = await hostClient.dispatch({
      idempotencyKey: mutationIdempotencyKey(`computer-use:request:${input.app.bundleId}`),
      input: {
        access: input.access,
        app: input.app,
        definitionId: view.definition.id,
        kind: "app",
        runnerId: machine.id,
      },
      type: "integration.computer.setup.request",
    });
    if (result.type !== "integration.computer.setup.request") {
      throw new Error("The approval was not requested.");
    }
    await actions.reviewSetup(result.request.id);
  }

  async function chooseAppApproval(next: ComputerUseAppApproval) {
    if (next === view.appApproval) return;
    await run(`policy:${next}`, async () => {
      if (next === "ask") {
        await askForEachComputerUseApp(hostClient, machine.id);
        return;
      }
      if (!local) return;
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`computer-use:policy:${machine.id}`),
        input: { appApproval: "automatic", kind: "policy", runnerId: machine.id },
        type: "integration.computer.setup.request",
      });
      if (result.type !== "integration.computer.setup.request") {
        throw new Error("App approvals did not change.");
      }
      await local.reviewSetup(result.request.id);
      // The policy is part of the Mac's summary, which the snapshot carries.
      await hostClient.refresh();
    });
  }

  /**
   * Remove under Ask for each app, Block under automatic. Either is one click:
   * the approval is durable, so taking it back is the easy direction, and a
   * task can ask again or the app can be unblocked on the Mac.
   */
  async function removeOrBlock(row: ComputerUseAppRow) {
    await run(appKey(row.connectionId), () =>
      takeBackComputerUseApp(hostClient, {
        appApproval: view.appApproval,
        connectionId: row.connectionId,
      }),
    );
  }

  async function unblock(row: ComputerUseAppRow) {
    if (!local) return;
    await run(appKey(row.connectionId), () =>
      askOnThisMac(local, { access: row.access, app: row.identity }),
    );
  }

  async function cancelPending(pending: ComputerUsePendingApp) {
    await run(`cancel:${pending.request.id}`, () =>
      cancelComputerUseSetup(hostClient, pending.request.id),
    );
  }

  const state = view.state;
  const ready = state.kind === "ready";
  const automatic = view.appApproval === "automatic";
  const localApprovalsReady =
    view.approvalKeyId !== null && (approvalKeySetup === null || approvalKeySetup.ready);
  // Only the desktop app running on this Mac can act for it; a browser open on
  // the same Mac is "elsewhere", like any other device.
  const viewer: ComputerUseViewer = { here: local !== null, machineName: machine.name };
  const firstRun = computerUseFirstRun(view);
  const hasList = view.apps.length > 0 || view.pending.length > 0;
  // Each failure sits on the row it acted on; only the App approvals choice,
  // which belongs to the whole block, reports under it.
  const failureFor = (key: string) => (failure?.key === key ? failure.message : null);
  const blockFailure = failure?.key.startsWith("policy:") ? failure.message : null;

  return (
    <div className="computer-use" id="computer-use">
      <div className="computer-apps__head computer-use__head">
        <span aria-hidden className="intg-icon computer-use__mark">
          <Icon name="laptop" />
        </span>
        <span className="card__row-body">
          <span className="card__row-title">Computer use</span>
          <span className="computer-apps__status computer-apps__status--line">
            <ToneDot tone={computerUseTone(view)} />
            <span>{computerUseStatusLine(view, viewer)}</span>
          </span>
        </span>
        {owned && ready && local && localApprovalsReady ? (
          <span className="computer-apps__control">
            <button
              className="btn btn--small"
              disabled={busy !== null}
              onClick={() => setAdding(true)}
              type="button"
            >
              <Icon name="plus" />
              Add app
            </button>
          </span>
        ) : null}
      </div>

      <div className="computer-use__body">
        {state.kind === "permission-required" || firstRun ? (
          <p className="computer-use__lead">{computerUseIntroduction(viewer)}</p>
        ) : null}

        {/* The status line already says why, in the Host's words; elsewhere
            the next step is on that Mac. */}
        {state.kind === "unavailable" && !viewer.here ? (
          <p className="computer-use__note">{computerUseInstallOn(machine.name)}</p>
        ) : null}

        {(state.kind === "ready" || state.kind === "permission-required") &&
        view.approvalKeyId === null ? (
          <div
            className="computer-use__approval-setup"
            role={approvalKeySetup?.error ? "alert" : "status"}
          >
            <strong>App approvals need setup.</strong>{" "}
            {approvalKeySetup?.error ? null : <span>{computerUseApprovalKeyStep(viewer)}</span>}
            {approvalKeySetup?.error ? (
              <>
                <span className="form-actions__error">{approvalKeySetup.error}</span>
                <button className="btn btn--small" onClick={approvalKeySetup.retry} type="button">
                  Retry
                </button>
              </>
            ) : null}
          </div>
        ) : state.kind !== "offline" && approvalKeySetup?.error ? (
          <div className="computer-use__approval-setup" role="alert">
            <strong>App approvals could not be set up.</strong>{" "}
            <span className="form-actions__error">{approvalKeySetup.error}</span>
            <button className="btn btn--small" onClick={approvalKeySetup.retry} type="button">
              Retry
            </button>
          </div>
        ) : null}

        {state.kind === "permission-required" ? (
          <PermissionSteps local={local} machineName={machine.name} missing={state.missing} />
        ) : null}

        {view.sessions.map((session) => (
          <ComputerUseSessionRow
            hostClient={hostClient}
            key={session.sessionId}
            machineName={machine.name}
            owned={owned}
            session={session}
          />
        ))}

        {owned && ready ? (
          <fieldset
            className={`computer-use__access${firstRun ? " computer-use__access--question" : ""}`}
            disabled={busy !== null}
          >
            <legend>{firstRun ? computerUseSetupQuestion : computerUseAppApprovalsTitle}</legend>
            {(["ask", "automatic"] as const).map((choice) => {
              // Automatic is confirmed in a window on the Mac it covers, so
              // elsewhere it can only be turned off, never on.
              const remoteOnly = choice === "automatic" && !automatic && !local;
              return (
                <label
                  className={`computer-use__option${view.appApproval === choice ? " computer-use__option--on" : ""}`}
                  key={choice}
                >
                  <input
                    checked={view.appApproval === choice}
                    disabled={remoteOnly || (choice === "automatic" && !localApprovalsReady)}
                    name={`computer-use-approval-${machine.id}`}
                    onChange={() => void chooseAppApproval(choice)}
                    type="radio"
                    value={choice}
                  />
                  <span className="computer-use__option-text">
                    <span className="computer-use__option-title">
                      {computerUseAppApprovalLabel[choice]}
                    </span>
                    <span className="computer-use__option-why">
                      {computerUseAppApprovalDetail(choice, machine.name)}
                    </span>
                    {remoteOnly ? (
                      <span className="computer-use__option-note">
                        {computerUseTurnOnFrom(machine.name)}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            {busy === "policy:automatic" ? (
              <p className="computer-use__fine" role="status">
                {computerUseConfirmOnThisMac}
              </p>
            ) : automatic ? (
              <p className="computer-use__fine">{computerUseAutomaticFootnote(view)}</p>
            ) : null}
          </fieldset>
        ) : null}

        {hasList ? (
          <ul className="computer-use__apps">
            {view.apps.map((row) => {
              const acting = busy === appKey(row.connectionId);
              const rowError = failureFor(appKey(row.connectionId));
              const takeBack = computerUseTakeBack({
                appApproval: view.appApproval,
                appName: row.identity.displayName,
                machineName: machine.name,
              });
              return (
                <li
                  aria-busy={acting || undefined}
                  className={`computer-use__app${row.blocked ? " computer-use__app--blocked" : ""}`}
                  key={row.connectionId}
                >
                  <AppMark identity={row.identity} />
                  <span className="card__row-body">
                    <span className="card__row-title">{row.identity.displayName}</span>
                    <span className="computer-use__app-meta">
                      {row.blocked ? (
                        <span className="chip chip--bad">Blocked</span>
                      ) : (
                        computerUseAccessLabel[row.access]
                      )}
                      {row.inUse && !row.blocked ? (
                        <span className="computer-use__in-use">In use</span>
                      ) : null}
                    </span>
                    {rowError ? (
                      <span className="form-actions__error" role="alert">
                        {rowError}
                      </span>
                    ) : null}
                  </span>
                  {owned ? (
                    row.blocked ? (
                      local ? (
                        <button
                          className="btn btn--ghost btn--small"
                          disabled={busy !== null || !localApprovalsReady}
                          onClick={() => void unblock(row)}
                          type="button"
                        >
                          {computerUseUnblockOn(viewer)}
                        </button>
                      ) : (
                        <span className="computer-use__app-where">
                          {computerUseUnblockOn(viewer)}
                        </span>
                      )
                    ) : (
                      <button
                        aria-label={`${takeBack.label} ${row.identity.displayName}`}
                        className="btn btn--ghost btn--small"
                        disabled={busy !== null}
                        onClick={() => void removeOrBlock(row)}
                        title={takeBack.consequence}
                        type="button"
                      >
                        {acting ? takeBack.busyLabel : takeBack.label}
                      </button>
                    )
                  ) : null}
                </li>
              );
            })}
            {view.pending.map((pending) => {
              // A task's request is the agent asking, so the owner declines it,
              // as on the thread's card; one the owner started is cancelled.
              const { threadId, threadTitle } = pending.request;
              const key = `cancel:${pending.request.id}`;
              const error = failureFor(key);
              const action = computerUsePendingAction(pending);
              return (
                <li
                  className="computer-use__app computer-use__app--pending"
                  key={pending.request.id}
                >
                  <AppMark identity={pending.identity} />
                  <span className="card__row-body">
                    <span className="card__row-title">{pending.identity.displayName}</span>
                    <span className="computer-use__app-meta">
                      {computerUseAccessLabel[pending.access]} ·{" "}
                      {computerUseApproveOn(computerUseWhere(viewer))}
                    </span>
                    {threadId ? (
                      <span className="computer-use__app-meta">
                        <span>
                          Asked in{" "}
                          <Link to={`/threads/${threadId}`}>
                            {threadTitle ?? "Untitled thread"}
                          </Link>
                        </span>
                      </span>
                    ) : null}
                    {error ? (
                      <span className="form-actions__error" role="alert">
                        {error}
                      </span>
                    ) : null}
                  </span>
                  {owned ? (
                    <button
                      aria-label={`${action.label} ${pending.identity.displayName}`}
                      className="btn btn--ghost btn--small"
                      disabled={busy !== null}
                      onClick={() => void cancelPending(pending)}
                      type="button"
                    >
                      {busy === key ? action.busyLabel : action.label}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {blockFailure ? (
          <p className="notice notice--error" role="alert">
            {blockFailure}
          </p>
        ) : null}
      </div>

      {adding && local ? (
        <AddAppDialog
          existing={view.apps}
          hostClient={hostClient}
          machine={machine}
          onApprove={(input) => askOnThisMac(local, input)}
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function appKey(connectionId: string): string {
  return `app:${connectionId}`;
}

/** The block's tone as a dot; the agent at work is its own ember, as everywhere. */
function ToneDot({ tone }: { readonly tone: ComputerUseTone }) {
  switch (tone) {
    case "live":
      return <span aria-hidden className="agent-dot" />;
    case "ready":
      return <span aria-hidden className="status-dot status-dot--ok" />;
    case "attention":
      return <span aria-hidden className="status-dot status-dot--warn" />;
    case "idle":
      return <span aria-hidden className="status-dot status-dot--idle" />;
  }
}

/** Matches the desktop docs: computer use needs a build signed with a Developer ID. */
const unsignedBuildSentence =
  "This build isn’t signed with a Developer ID, so it can’t set up computer use. See SIGNING.md.";

/**
 * The two macOS grants as steps, each with its state and — on the Mac itself —
 * one button that opens the desktop's permission panel over System Settings.
 * Elsewhere the copy names the Mac, because nothing here can grant it remotely.
 */
function PermissionSteps({
  local,
  machineName,
  missing,
}: {
  readonly local: ComputerUseLocalActions | null;
  readonly machineName: string;
  readonly missing: readonly ComputerUseGrant[];
}) {
  const [setupFailure, setSetupFailure] = useState<string | null>(null);
  const setupAttempt = useRef(0);
  function setUp(actions: ComputerUseLocalActions) {
    const attempt = ++setupAttempt.current;
    setSetupFailure(null);
    void actions.openPermissions().then(
      (result) => {
        if (attempt === setupAttempt.current) {
          setSetupFailure(result.opened ? null : unsignedBuildSentence);
        }
      },
      (reason: unknown) => {
        if (attempt === setupAttempt.current) setSetupFailure(actionErrorMessage(reason));
      },
    );
  }
  return (
    <div className="computer-use__setup">
      <ol className="computer-use__grants">
        {computerUseGrantOrder.map((grant) => {
          const done = !missing.includes(grant);
          return (
            <li
              className={`computer-use__grant${done ? " computer-use__grant--done" : ""}`}
              key={grant}
            >
              <span aria-hidden className="computer-use__grant-mark">
                {done ? <Icon name="check" /> : null}
              </span>
              <span className="computer-use__grant-text">
                <span>{computerUseGrantLabel[grant]}</span>
                <span className="computer-use__grant-why">{computerUseGrantPurpose[grant]}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {local ? (
        <div className="computer-use__setup-actions">
          <button
            className="btn btn--primary btn--small"
            onClick={() => setUp(local)}
            type="button"
          >
            Set up on this Mac
          </button>
          <span className="computer-use__setup-hint">
            Switch on <strong>{computerUseHelperName}</strong> in both lists. Your other apps and
            Opensteer itself get no new access.
          </span>
          {setupFailure ? (
            <p className="notice notice--error" role="alert">
              {setupFailure}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="computer-use__setup-hint">
          <strong>{computerUseSetUpFrom(machineName)}.</strong>{" "}
          {computerUseSetUpFromSteps(machineName)}
        </p>
      )}
    </div>
  );
}

/** An app's icon as the Mac drew it, or its initial when the Mac is away. */
export function AppMark({
  iconPng,
  identity,
  machineId,
}: {
  readonly iconPng?: string | undefined;
  readonly identity: ComputerAppIdentity;
  /** The Mac the app is on, to read its real icon from; its initial until then. */
  readonly machineId?: string | null | undefined;
}) {
  const className = "intg-icon computer-use__app-mark";
  const read = useAppIcon(iconPng ? null : machineId, identity);
  const png = iconPng ?? read;
  if (png) {
    return (
      <img alt="" className={className} decoding="async" src={`data:image/png;base64,${png}`} />
    );
  }
  return (
    <span aria-hidden className={`${className} intg-icon--monogram`}>
      {identity.displayName.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Pick an installed app and what agents may do with it, in one choice.
 *
 * The Mac does the searching: it is the only thing that knows what is
 * installed, and a listing is paged there rather than shipped whole. Each
 * choice opens this Mac's own approval window directly, which is the one
 * confirmation; the page waits for its answer. An app that is already
 * approved or blocked is listed as such rather than offered twice.
 */
function AddAppDialog({
  existing,
  hostClient,
  machine,
  onApprove,
  onClose,
  onDone,
}: {
  readonly existing: readonly ComputerUseAppRow[];
  readonly hostClient: HostClient;
  readonly machine: MachineSummary;
  readonly onApprove: (input: {
    readonly access: IntegrationAccess;
    readonly app: ComputerAppIdentity;
  }) => Promise<void>;
  readonly onClose: () => void;
  readonly onDone: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<{
    readonly apps: readonly ComputerUseInstalledApp[];
    readonly query: string;
    readonly total: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{
    readonly access: IntegrationAccess;
    readonly bundleId: string;
  } | null>(null);
  const [askError, setAskError] = useState<Failure | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  const load = useCallback(
    (search: string, offset: number) => {
      const current = ++generation.current;
      setLoading(true);
      setLoadError(null);
      hostClient.rpc["integration.computer.apps.installed"]({
        icons: true,
        limit: pickerPageSize,
        offset,
        query: search,
        runnerId: machine.id,
      })
        .then(unwrapRpcResult)
        .then((result) => {
          if (current !== generation.current) return;
          if (result.unavailableReason) {
            setListing(null);
            setLoadError(
              result.unavailableReason === "offline"
                ? `${machine.name} is offline.`
                : `${machine.name} isn’t ready to list apps yet.`,
            );
            return;
          }
          setListing((previous) => ({
            apps:
              offset > 0 && previous?.query === search
                ? [...previous.apps, ...result.apps]
                : result.apps,
            query: search,
            total: result.total,
          }));
        })
        .catch((reason: unknown) => {
          if (current === generation.current) setLoadError(actionErrorMessage(reason));
        })
        .finally(() => {
          if (current === generation.current) setLoading(false);
        });
    },
    [hostClient, machine.id, machine.name],
  );

  useEffect(() => {
    const search = query.trim();
    const timer = globalThis.setTimeout(() => load(search, 0), search ? pickerSearchDelayMs : 0);
    return () => globalThis.clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const known = useMemo(
    () => new Map(existing.map((row) => [row.identity.bundleId.toLowerCase(), row])),
    [existing],
  );

  async function choose(app: ComputerUseInstalledApp, access: IntegrationAccess) {
    if (asking) return;
    setAsking({ access, bundleId: app.identity.bundleId });
    setAskError(null);
    try {
      await onApprove({ access, app: app.identity });
      await onDone();
    } catch (reason) {
      setAskError({ key: app.identity.bundleId, message: actionErrorMessage(reason) });
      setAsking(null);
    }
  }

  const apps = listing?.apps ?? [];
  // A bundle id means nothing to most people; it is shown only to tell apart
  // two apps that go by the same name.
  const sharedNames = useMemo(() => {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const app of apps) {
      const name = app.identity.displayName.toLowerCase();
      if (seen.has(name)) shared.add(name);
      seen.add(name);
    }
    return shared;
  }, [apps]);

  return (
    <Dialog
      labelledBy="computer-use-add-title"
      onClose={onClose}
      title={<span id="computer-use-add-title">Add an app on {machine.name}</span>}
    >
      <div className="computer-use__picker">
        <p className="computer-use__fine">
          Pick what agents may do with an app. You confirm it on this Mac next.
        </p>
        <label className="computer-use__search">
          <Icon name="search" />
          <input
            aria-label="Search installed apps"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps on this Mac"
            ref={searchRef}
            type="search"
            value={query}
          />
        </label>
        {loadError ? (
          <p className="notice notice--error" role="alert">
            {loadError}
          </p>
        ) : listing === null ? (
          <p className="computer-use__fine">Asking {machine.name} for its apps…</p>
        ) : apps.length === 0 ? (
          <p className="computer-use__fine">
            {listing.query ? `No app matches “${listing.query}”.` : "No apps found on this Mac."}
          </p>
        ) : (
          <ul aria-label="Installed apps" className="computer-use__list">
            {apps.map((app) => {
              const { bundleId, displayName } = app.identity;
              const row = known.get(bundleId.toLowerCase());
              const error = askError?.key === bundleId ? askError.message : null;
              return (
                <li
                  aria-busy={asking?.bundleId === bundleId || undefined}
                  className="computer-use__app"
                  key={bundleId}
                >
                  <AppMark iconPng={app.iconPng} identity={app.identity} />
                  <span className="card__row-body">
                    <span className="card__row-title">{displayName}</span>
                    {row || sharedNames.has(displayName.toLowerCase()) ? (
                      <span className="computer-use__app-meta">
                        {row
                          ? row.blocked
                            ? "Blocked"
                            : `Approved · ${computerUseAccessLabel[row.access]}`
                          : bundleId}
                      </span>
                    ) : null}
                    {error ? (
                      <span className="form-actions__error" role="alert">
                        {error}
                      </span>
                    ) : null}
                  </span>
                  {row ? null : (
                    <span
                      aria-label={`Add ${displayName}`}
                      className="computer-use__choices"
                      role="group"
                    >
                      {(["read", "read-write"] as const).map((access) => (
                        <button
                          className="btn btn--small"
                          disabled={asking !== null}
                          key={access}
                          onClick={() => void choose(app, access)}
                          type="button"
                        >
                          {asking?.bundleId === bundleId && asking.access === access
                            ? "Confirming…"
                            : computerUseAccessLabel[access]}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {listing && apps.length < listing.total && !loadError ? (
          <button
            className="btn btn--ghost btn--small computer-use__more"
            disabled={loading}
            onClick={() => load(listing.query, apps.length)}
            type="button"
          >
            {loading ? "Loading…" : "Show more"}
          </button>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * One task using this Mac, and its Stop. The Stop is the same one the task's
 * own line and live view show, so pressing it here is seen there too.
 */
function ComputerUseSessionRow({
  hostClient,
  machineName,
  owned,
  session,
}: {
  hostClient: HostClient;
  machineName: string;
  owned: boolean;
  session: ComputerUseSessionSummary;
}) {
  const stop = useComputerUseStop(hostClient, session.sessionId);
  const stopping = stop?.phase === "stopping" || stop?.phase === "stopped";
  return (
    <div className="computer-use__session" role="status">
      <span aria-hidden className="agent-dot" />
      <span className="computer-use__session-text">
        <strong>{computerUseSessionTitle(session)}</strong>
        <span aria-hidden> · </span>
        <Link to={`/threads/${session.threadId}`}>{session.threadTitle ?? "Untitled thread"}</Link>
        {stop?.phase === "failed" ? (
          <span className="form-actions__error" role="alert">
            {stop.message}
          </span>
        ) : null}
      </span>
      {owned ? (
        <button
          aria-label={`Stop ${computerUseSessionTitle(session)} on ${machineName}`}
          className="btn btn--small btn--danger"
          disabled={stopping}
          onClick={() =>
            computerUseStops(hostClient).stop({
              machineName,
              runId: session.runId,
              sessionId: session.sessionId,
            })
          }
          type="button"
        >
          <Icon name="stop" />
          {stopping ? "Stopping…" : "Stop"}
        </button>
      ) : null}
    </div>
  );
}
