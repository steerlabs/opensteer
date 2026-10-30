import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  sameIntegrationOAuthApplicationSource,
  type IntegrationAuthorizationStart,
  type IntegrationAuthorizationStatus,
  type IntegrationConnectionSummary,
  type IntegrationDashboard,
  type IntegrationOAuthApplicationSource,
  type IntegrationProviderApplication,
  type IntegrationProviderManifest,
  type SaveIntegrationProviderApplication,
} from "@opensteer/integration-core/models";
import type { IntegrationRepositoryAccess } from "@opensteer/integration-core";
import type { IntegrationDefinitionSummaryView } from "@opensteer/integration-core/adapter";
import { Dialog } from "../dialog.js";
import { ExternalLink } from "../external-link.js";
import { Icon } from "../icon.js";
import { integrationAuthorizationError } from "../../integrations/integration-authorization.js";
import { IntegrationIcon } from "./integration-icon.js";
import { message, secretFieldLabel } from "./helpers.js";
import {
  canSetUpOwnApp,
  authorizationConnection,
  canShareApps,
  connectAvailability,
  connectChoiceAvailable,
  connectOption,
  connectProviderManifest,
  connectSavedSource,
  connectSignInOptions,
  connectedAccount,
  hostedOAuthOutage,
  initialConnectSource,
  integrationAccountTitle,
  manageableApplication,
  repositoryAccountStep,
  type ConnectAvailability,
  type ConnectSignInOption,
} from "@opensteer/client/integrations";
import type { ConnectOperations } from "./connect-operations.js";

type Step =
  | { readonly kind: "choose" }
  /** A sign-in the click already began, before the Host has answered with its attempt. */
  | { readonly kind: "opening" }
  | { readonly editing: IntegrationProviderApplication | null; readonly kind: "setup" }
  | { readonly kind: "authorizing"; readonly started: IntegrationAuthorizationStart }
  | {
      readonly access: IntegrationRepositoryAccess | null;
      readonly connection: IntegrationConnectionSummary;
      readonly kind: "repository-access";
    }
  | { readonly connection: IntegrationConnectionSummary; readonly kind: "connected" };

/**
 * The one Connect flow, used by Settings and by an agent's access Request.
 *
 * Two things it will not do: report a connection that the durable attempt and a
 * reloaded connection row do not both show, and change the sign-in app a person
 * picked. The dashboard it renders is seeded once and replaced only by its own
 * reloads, so a background refresh cannot move the selection under the person
 * who made it.
 */
export function ConnectFlow({
  begun = null,
  dashboard,
  definition,
  onClose,
  onConnected,
  operations,
  purpose,
  requestedBy = null,
  returnPath,
}: {
  /**
   * A sign-in already begun from the click that opened this sheet, which alone
   * may open its browser tab. The sheet follows it instead of asking first.
   */
  readonly begun?: Promise<IntegrationAuthorizationStart> | null;
  readonly dashboard: IntegrationDashboard;
  readonly definition: IntegrationDefinitionSummaryView;
  readonly onClose: () => void;
  readonly onConnected: (connectionId: string) => void;
  readonly operations: ConnectOperations;
  readonly purpose: string;
  readonly requestedBy?: string | null;
  readonly returnPath: string;
}) {
  const provider = definition.provider;
  const [live, setLive] = useState(dashboard);
  const [chosen, setChosen] = useState<IntegrationOAuthApplicationSource | null>(() =>
    initialConnectSource(dashboard, provider),
  );
  const [changing, setChanging] = useState(false);
  const [step, setStep] = useState<Step>(begun ? { kind: "opening" } : { kind: "choose" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * The one operation that may change this sheet: a sign-in, a cancelled
   * sign-in's recovery, a recheck or a save. It owns the sheet and `pending`
   * until it settles, another starts, or the sheet closes, and one that no
   * longer owns the sheet changes nothing. Aborting it ends a sign-in's wait.
   * "Finish signing in" is shown only while its sign-in, or the recovery that
   * took over from it, owns the sheet, so its Cancel always has an owner.
   */
  const operation = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      operation.current?.abort();
      operation.current = null;
    },
    [],
  );

  const start = (): AbortController => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setError(null);
    setPending(true);
    return controller;
  };
  const owns = (controller: AbortController | null): controller is AbortController =>
    controller !== null && operation.current === controller && !controller.signal.aborted;
  const settle = (controller: AbortController): void => {
    if (!owns(controller)) return;
    operation.current = null;
    setPending(false);
  };

  const manifest = connectProviderManifest(live, provider);
  const options = connectSignInOptions(live, provider);
  const availability = connectAvailability(live, provider);
  const chosenOption = connectOption(options, chosen);
  const choiceLost = !connectChoiceAvailable(options, chosen);
  const editable = manageableApplication(chosenOption);
  // Opensteer's service can be down while another eligible app still works, so
  // this is a note beside a working chooser, not a blocked flow.
  const hostedOutage = hostedOAuthOutage(live, provider) && availability.kind === "ready";
  const connectable = availability.kind === "ready";
  const ownAppSetup = canSetUpOwnApp(live, provider);

  /**
   * GitHub's repository check, the first and every recheck. After a refusal
   * the sheet reloads the account and goes where the Host put it
   * (`repositoryAccountStep`), and answers no access to show.
   */
  const checkRepositories = async (
    connection: IntegrationConnectionSummary,
    controller: AbortController,
  ): Promise<IntegrationRepositoryAccess | null> => {
    try {
      return await operations.checkRepositoryAccess(connection.id);
    } catch (reason) {
      if (!owns(controller)) return null;
      // An account that cannot be reloaded keeps its saved sign-in and this step.
      const reloaded = await operations.reloadDashboard().catch(() => null);
      if (!owns(controller)) return null;
      if (reloaded) setLive(reloaded);
      const next = reloaded
        ? repositoryAccountStep(reloaded, connection.id)
        : ({ connection, kind: "repository-access" } as const);
      if (next.kind === "connected") {
        setStep({ connection: next.connection, kind: "connected" });
        onConnected(connection.id);
      } else if (next.kind === "sign-in") {
        setError(next.detail ?? message(reason));
        setStep({ kind: "choose" });
      } else {
        setError(message(reason));
        setStep((current) =>
          current.kind === "repository-access"
            ? current
            : { access: null, connection: next.connection, kind: "repository-access" },
        );
      }
      return null;
    }
  };

  const finishConnection = async (
    connection: IntegrationConnectionSummary,
    controller: AbortController,
  ) => {
    if (connection.provider === "github") {
      const access = await checkRepositories(connection, controller);
      if (access === null || !owns(controller)) return;
      if (!access.ready) {
        setStep({ access, connection, kind: "repository-access" });
        return;
      }
    }
    setStep({ connection, kind: "connected" });
    onConnected(connection.id);
  };

  /**
   * A terminal attempt, as a sign-in's wait or Cancel answered it: the reason
   * it did not connect, or the connection a reloaded row shows. One that
   * cannot be finished goes back to sign-in, its reason shown, whichever of
   * the two answered.
   */
  const finishAttempt = async (
    status: IntegrationAuthorizationStatus,
    controller: AbortController,
    unrecorded: string,
  ) => {
    try {
      const outcome = integrationAuthorizationError(status.status, status.failureCode);
      if (outcome) {
        setError(outcome);
        setStep({ kind: "choose" });
        return;
      }
      const reloaded = await operations.reloadDashboard();
      if (!owns(controller)) return;
      setLive(reloaded);
      const connection = authorizationConnection(reloaded, status.connectionId);
      if (!connection) {
        setError(unrecorded);
        setStep({ kind: "choose" });
        return;
      }
      await finishConnection(connection, controller);
    } catch (reason) {
      if (!owns(controller)) return;
      setError(message(reason));
      setStep({ kind: "choose" });
    }
  };

  /** Follows one sign-in from its start to a connection or the reason it has none. */
  const follow = async (starting: Promise<IntegrationAuthorizationStart>) => {
    setNotice(null);
    const controller = start();
    try {
      const started = await starting;
      if (!owns(controller)) return;
      setStep({ kind: "authorizing", started });
      const status = await operations.awaitAuthorization(started, controller.signal);
      if (!owns(controller)) return;
      await finishAttempt(
        status,
        controller,
        `${definition.name} reported success, but no connected account is recorded here. Start the connection again.`,
      );
    } catch (reason) {
      if (!owns(controller)) return;
      setError(message(reason));
      setStep({ kind: "choose" });
    } finally {
      settle(controller);
    }
  };

  // Called from the click, so the browser tab opens while it still may.
  const connect = () =>
    follow(
      operations.beginAuthorization({
        applicationSource: chosen,
        definitionId: definition.id,
        returnPath,
      }),
    );

  // Strict mode mounts twice; the second mount follows the same attempt again.
  const initial = useRef(begun);
  useEffect(() => {
    if (initial.current) void follow(initial.current);
  }, []);

  /**
   * Cancel belongs to the operation that shows it, the sign-in or the
   * recovery that took over from it: once that has settled or another has
   * started, its answer changes nothing. Otherwise the answer ends the wait and
   * a recovery takes the sheet over, since a sign-in that completed first still
   * has its connection to finish.
   */
  const cancel = async (started: IntegrationAuthorizationStart) => {
    const signIn = operation.current;
    const status = await operations
      .cancelAuthorization(started.attemptId)
      .catch((reason: unknown) => {
        // Nothing was cancelled, so the sign-in keeps waiting and can still finish.
        if (owns(signIn)) setError(message(reason));
        return null;
      });
    if (status === null || !owns(signIn)) return;
    const controller = start();
    try {
      await finishAttempt(
        status,
        controller,
        `${definition.name} completed while cancellation was requested, but no connected account is recorded here. Reload and try again.`,
      );
    } finally {
      settle(controller);
    }
  };

  const save = async (draft: SaveIntegrationProviderApplication) => {
    const controller = start();
    try {
      // The Host answers with the record it wrote. Two registrations can carry
      // the same name and client id, so that id and revision are the only way
      // to name the app this person just saved.
      const saved = await operations.saveProviderApplication(draft);
      const reloaded = await operations.reloadDashboard();
      if (!owns(controller)) return;
      setLive(reloaded);
      // Saving selects the app for this attempt and nothing more: an account is
      // connected only by authorizing at the provider.
      const savedSource = connectSavedSource(reloaded, saved);
      if (savedSource) setChosen(savedSource);
      setChanging(false);
      setStep({ kind: "choose" });
      setNotice(
        savedSource
          ? `App saved. No account is connected yet — continue to ${definition.name} to connect one.`
          : `App saved, but this deployment is not offering it for sign-in yet. No account is connected.`,
      );
    } catch (reason) {
      if (owns(controller)) setError(message(reason));
    } finally {
      settle(controller);
    }
  };

  /**
   * Turning an app off withdraws its sign-in for everyone it was offered to and
   * leaves every account made with it needing a reconnection; nothing here
   * repoints those accounts at another app.
   */
  const changeStatus = async (input: {
    readonly application: IntegrationProviderApplication;
    readonly status: "active" | "disabled";
  }) => {
    const controller = start();
    try {
      await operations.setApplicationStatus({
        applicationId: input.application.id,
        expectedRevision: input.application.revision,
        provider: input.application.provider,
        status: input.status,
      });
      const reloaded = await operations.reloadDashboard();
      if (!owns(controller)) return;
      setLive(reloaded);
      setStep({ kind: "choose" });
      setNotice(
        input.status === "disabled"
          ? "App disabled. Accounts connected with it must be reconnected through another app."
          : "App enabled.",
      );
    } catch (reason) {
      if (owns(controller)) setError(message(reason));
    } finally {
      settle(controller);
    }
  };

  const openSetup = (editing: IntegrationProviderApplication | null) => {
    setError(null);
    setNotice(null);
    setStep({ editing, kind: "setup" });
  };

  /**
   * A service that is down is worth asking about again; nothing about a retry
   * changes the app this person picked.
   */
  const recheck = async () => {
    const controller = start();
    try {
      const reloaded = await operations.reloadDashboard();
      if (owns(controller)) setLive(reloaded);
    } catch (reason) {
      if (owns(controller)) setError(message(reason));
    } finally {
      settle(controller);
    }
  };

  const recheckRepositories = async (connection: IntegrationConnectionSummary): Promise<void> => {
    const controller = start();
    try {
      const access = await checkRepositories(connection, controller);
      if (access === null || !owns(controller)) return;
      if (access.ready) {
        const reloaded = await operations.reloadDashboard();
        if (!owns(controller)) return;
        setLive(reloaded);
        const current = connectedAccount(reloaded, connection.id) ?? connection;
        setStep({ connection: current, kind: "connected" });
        onConnected(connection.id);
      } else {
        setStep({ access, connection, kind: "repository-access" });
      }
    } catch (reason) {
      if (owns(controller)) setError(message(reason));
    } finally {
      settle(controller);
    }
  };

  const footer =
    step.kind === "authorizing" || step.kind === "opening" ? (
      <button
        className="btn"
        disabled={step.kind === "opening"}
        onClick={() => step.kind === "authorizing" && void cancel(step.started)}
        type="button"
      >
        Cancel
      </button>
    ) : step.kind === "repository-access" ? (
      <>
        <button className="btn" disabled={pending} onClick={onClose} type="button">
          Finish later
        </button>
        <button
          className="btn btn--primary"
          disabled={pending}
          onClick={() => void recheckRepositories(step.connection)}
          type="button"
        >
          {pending ? "Checking…" : "Recheck repository access"}
        </button>
      </>
    ) : step.kind === "connected" ? (
      <button className="btn btn--primary" onClick={onClose} type="button">
        Done
      </button>
    ) : step.kind === "setup" ? null : (
      <>
        {ownAppSetup ? (
          <button
            className={connectable ? "btn" : "btn btn--primary"}
            disabled={pending}
            onClick={() => openSetup(null)}
            type="button"
          >
            {connectable
              ? `Use my own ${definition.name} app`
              : `Set up my own ${definition.name} app`}
          </button>
        ) : null}
        {availability.kind === "account-link" ? (
          <Link className="btn" to="/settings/general">
            Link Account
          </Link>
        ) : null}
        {availability.kind === "hosted-outage" || hostedOutage ? (
          <button className="btn" disabled={pending} onClick={() => void recheck()} type="button">
            Retry Opensteer sign-in
          </button>
        ) : null}
        {/* Nothing to continue to until an eligible app is chosen, so the
            action that does work is the only one offered. */}
        {connectable ? (
          <button
            className="btn btn--primary"
            disabled={pending || chosenOption === null || choiceLost}
            onClick={() => void connect()}
            title="Opens authorization in a browser tab"
            type="button"
          >
            {pending ? "Opening…" : `Continue to ${definition.name}`}
            <Icon name="external-link" />
          </button>
        ) : null}
      </>
    );

  return (
    <Dialog
      footer={footer}
      labelledBy={`connect-${definition.id}`}
      onClose={onClose}
      title={
        step.kind === "connected"
          ? `${definition.name} connected`
          : step.kind === "repository-access"
            ? "Choose GitHub repositories"
            : step.kind === "setup"
              ? `Your ${definition.name} app`
              : `Connect ${definition.name}`
      }
    >
      {error ? (
        <div className="notice notice--error" role="alert">
          <Icon name="alert-circle" />
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="notice notice--accent" role="status">
          <Icon name="check-circle" />
          <span>{notice}</span>
        </div>
      ) : null}

      {/* Said while signing in too: which account to pick is the provider's question. */}
      {step.kind === "choose" || step.kind === "opening" || step.kind === "authorizing" ? (
        <div className="connect-sheet__lede">
          <IntegrationIcon
            icon={definition.icon}
            id={definition.id}
            name={definition.name}
            size="lg"
          />
          <div className="connect-sheet__lede-copy">
            <p>{purpose}</p>
            {requestedBy ? (
              <p className="field__hint">{requestedBy} asked for this connection.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {step.kind === "choose" ? (
        <>
          {hostedOutage ? (
            <div className="notice notice--warn" role="status">
              <Icon name="alert-circle" />
              <div>
                <strong>Opensteer sign-in is temporarily unavailable</strong>
                <p>
                  This is an outage, not missing setup. Retry, or continue with another app below.
                </p>
              </div>
            </div>
          ) : null}

          {availability.kind === "ready" ? (
            <SignInApp
              changing={changing || (chosenOption === null && !choiceLost)}
              chosen={chosen}
              choiceLost={choiceLost}
              editable={editable}
              onChange={(source) => {
                setChosen(source);
                setChanging(false);
              }}
              onChanging={() => setChanging(true)}
              onEdit={openSetup}
              options={options}
              selected={chosenOption}
            />
          ) : (
            <Unavailable availability={availability} name={definition.name} />
          )}
        </>
      ) : null}

      {step.kind === "setup" && manifest ? (
        <OwnAppForm
          applications={live.applications.filter(
            (application) => application.provider === provider,
          )}
          callbackUrl={live.callbackUrls[provider] ?? ""}
          canShare={canShareApps(live)}
          editing={step.editing}
          manifest={manifest}
          onCancel={() => {
            setError(null);
            setStep({ kind: "choose" });
          }}
          onSave={(draft) => void save(draft)}
          onStatus={(input) => void changeStatus(input)}
          pending={pending}
        />
      ) : null}

      {step.kind === "authorizing" || step.kind === "opening" ? (
        <div className="notice notice--accent" role="status">
          <Icon name="external-link" />
          <div>
            <strong>Finish signing in to {definition.name}</strong>
            <p>Use the sign-in page that opened. This updates by itself when you’re done.</p>
          </div>
        </div>
      ) : null}

      {step.kind === "connected" ? (
        <ConnectedFacts connection={step.connection} name={definition.name} />
      ) : null}
      {step.kind === "repository-access" ? <RepositoryAccessSetup access={step.access} /> : null}
    </Dialog>
  );
}

export function RepositoryAccessSetup({
  access,
}: {
  readonly access: IntegrationRepositoryAccess | null;
}) {
  if (access === null) {
    return (
      <div className="notice notice--warn" role="status">
        <Icon name="alert-circle" />
        <div>
          <strong>Repository access could not be checked</strong>
          <p>Your GitHub sign-in is saved. Recheck instead of signing in again.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="card__form">
      <div className="notice notice--warn" role="status">
        <Icon name="alert-circle" />
        <div>
          <strong>Repository access is still required</strong>
          <p>Install the GitHub App or choose at least one repository, then recheck.</p>
        </div>
      </div>
      {access.installationUrl ? (
        <ExternalLink className="btn btn--primary" href={access.installationUrl}>
          Install GitHub App <Icon name="external-link" />
        </ExternalLink>
      ) : access.installations.length === 0 ? (
        <p className="field__hint">
          No installation link is configured for this sign-in app. Edit your own app registration,
          or ask an administrator to configure its installation URL.
        </p>
      ) : null}
      {access.installations.map((installation) => (
        <div className="connect-sheet__app" key={installation.id}>
          <div className="connect-sheet__app-copy">
            <span className="card__row-title">{installation.accountLogin}</span>
            <span className="card__row-detail">
              {installation.suspended
                ? "Installation suspended"
                : installation.repositorySelection === "all"
                  ? `${installation.repositoryCount} repositories · all repositories`
                  : `${installation.repositoryCount} selected repositories`}
            </span>
          </div>
          <ExternalLink className="btn btn--small" href={installation.configureUrl}>
            Choose/change repositories <Icon name="external-link" />
          </ExternalLink>
        </div>
      ))}
    </div>
  );
}

/** Which app signs you in, and the explicit choice between the eligible ones. */
export function SignInApp({
  changing,
  choiceLost,
  chosen,
  editable,
  onChange,
  onChanging,
  onEdit,
  options,
  selected,
}: {
  readonly changing: boolean;
  readonly choiceLost: boolean;
  readonly chosen: IntegrationOAuthApplicationSource | null;
  readonly editable: IntegrationProviderApplication | null;
  readonly onChange: (source: IntegrationOAuthApplicationSource) => void;
  readonly onChanging: () => void;
  readonly onEdit: (application: IntegrationProviderApplication) => void;
  readonly options: readonly ConnectSignInOption[];
  readonly selected: ConnectSignInOption | null;
}) {
  if (choiceLost) {
    return (
      <div className="notice notice--warn" role="alert">
        <Icon name="alert-circle" />
        <div>
          <strong>The app you chose is no longer offered</strong>
          <p>Choose a sign-in app below. Opensteer never switches it for you.</p>
        </div>
      </div>
    );
  }
  if (!changing && selected) {
    return (
      <div className="connect-sheet__app">
        <div className="connect-sheet__app-copy">
          <span className="card__row-title">Sign-in app: {selected.label}</span>
          <span className="card__row-detail">{selected.detail}</span>
        </div>
        {editable ? (
          <button className="btn btn--small" onClick={() => onEdit(editable)} type="button">
            Edit
          </button>
        ) : null}
        {options.length > 1 ? (
          <button className="btn btn--small" onClick={onChanging} type="button">
            Change
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <fieldset className="choice-fieldset">
      <legend className="card__row-title">Choose a sign-in app</legend>
      {options.map((option) => (
        <label className="check-item" key={optionKey(option)}>
          <input
            checked={
              chosen !== null && sameIntegrationOAuthApplicationSource(option.source, chosen)
            }
            name="connect-sign-in-app"
            onChange={() => onChange(option.source)}
            type="radio"
          />
          <span className="check-item__meta">
            <span className="check-item__label">{option.label}</span>
            <span className="check-item__detail">{option.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function optionKey(option: ConnectSignInOption): string {
  return option.source.kind === "hosted-oauth"
    ? `hosted:${option.source.brokerIssuer}`
    : `app:${option.source.providerApplicationId}`;
}

/**
 * Missing configuration and a withdrawn app are different problems and read
 * differently here. Neither of them is the provider's own administrator
 * approval, which happens at the provider and is not this deployment's policy.
 */
export function Unavailable({
  availability,
  name,
}: {
  readonly availability: Exclude<ConnectAvailability, { readonly kind: "ready" }>;
  readonly name: string;
}) {
  const title =
    availability.kind === "setup-required"
      ? `Opensteer sign-in is not available for ${name} yet`
      : availability.kind === "hosted-outage"
        ? "Opensteer sign-in is temporarily unavailable"
        : availability.kind === "source-unavailable"
          ? `The ${name} sign-in app is no longer offered`
          : availability.kind === "account-link"
            ? "This deployment needs a linked Opensteer Account"
            : `Connect ${name} on the computer running this deployment`;
  const guidance =
    availability.kind === "other-surface"
      ? null
      : availability.kind === "hosted-outage"
        ? "This is an outage, not missing setup. Retry in a moment."
        : availability.canSetUpOwnApp
          ? `Register your own ${name} app to connect an account.`
          : `This deployment does not offer ${name} sign-in setup.`;
  return (
    <div className="notice notice--warn" role="status">
      <Icon name="alert-circle" />
      <div>
        <strong>{title}</strong>
        <p>{availability.detail}</p>
        {guidance ? <p>{guidance}</p> : null}
      </div>
    </div>
  );
}

/**
 * The provider's own setup, from the manifest the Host publishes: its steps, its
 * console, its secret fields, and this deployment's real callback. No editable
 * endpoints and no scopes invented here — the definition already declares the
 * consent set the provider will be asked for.
 */
export function OwnAppForm({
  applications,
  callbackUrl,
  canShare,
  editing,
  manifest,
  onCancel,
  onSave,
  onStatus,
  pending,
}: {
  readonly applications: readonly IntegrationProviderApplication[];
  readonly callbackUrl: string;
  readonly canShare: boolean;
  readonly editing: IntegrationProviderApplication | null;
  readonly manifest: IntegrationProviderManifest;
  readonly onCancel: () => void;
  readonly onSave: (draft: SaveIntegrationProviderApplication) => void;
  readonly onStatus: (input: {
    readonly application: IntegrationProviderApplication;
    readonly status: "active" | "disabled";
  }) => void;
  readonly pending: boolean;
}) {
  const [shared, setShared] = useState(editing?.availability === "deployment");
  const [clientId, setClientId] = useState(editing?.clientId ?? "");
  const [displayName, setDisplayName] = useState(editing?.displayName ?? manifest.label);
  const [installationUrl, setInstallationUrl] = useState(editing?.installationUrl ?? "");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  // Sharing an app edits the one shared record, so the deployment can never end
  // up with two, and a member's own app is never overwritten by that choice.
  const target =
    editing ??
    (shared
      ? (applications.find(({ availability }) => availability === "deployment") ?? null)
      : null);
  const savedSecretFields = target?.configuredSecretFields ?? [];
  return (
    <form
      className="card__form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          ...(target ? { applicationId: target.id } : {}),
          availability: shared ? "deployment" : "personal",
          clientId,
          displayName,
          expectedRevision: target?.revision ?? null,
          ...(manifest.installationUrlRequired
            ? { installationUrl: installationUrl.trim() || null }
            : {}),
          provider: manifest.provider,
          secrets,
        });
      }}
    >
      <p className="field__hint">
        Create a {manifest.setupLabel}, then paste its credentials here. Saving the app does not
        connect an account.
      </p>
      <ol className="field__hint">
        {manifest.setupSteps.map((setupStep) => (
          <li key={setupStep}>{setupStep}</li>
        ))}
      </ol>
      <ExternalLink className="btn btn--small" href={manifest.setupUrl}>
        Open {manifest.label} console <Icon name="external-link" />
      </ExternalLink>
      <label className="field">
        <span className="field__label">Authorized callback URL</span>
        <div className="copy-row">
          <code>{callbackUrl}</code>
          <button
            className="btn btn--small"
            onClick={() => {
              void navigator.clipboard.writeText(callbackUrl).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              });
            }}
            type="button"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </label>
      {manifest.installationUrlRequired ? (
        <label className="field">
          <span className="field__label">GitHub App installation URL</span>
          <input
            autoComplete="off"
            className="text-input"
            onChange={(event) => setInstallationUrl(event.target.value)}
            placeholder="https://github.com/apps/your-app/installations/new"
            required
            type="url"
            value={installationUrl}
          />
          <span className="field__hint">
            Opensteer uses this exact URL after sign-in so people can choose repositories.
          </span>
        </label>
      ) : null}
      <label className="field">
        <span className="field__label">App name</span>
        <input
          autoComplete="off"
          className="text-input"
          onChange={(event) => setDisplayName(event.target.value)}
          required
          value={displayName}
        />
      </label>
      <label className="field">
        <span className="field__label">Client ID</span>
        <input
          autoComplete="off"
          className="text-input"
          onChange={(event) => setClientId(event.target.value)}
          required
          value={clientId}
        />
      </label>
      {manifest.secretFields.map((field) => {
        const saved = savedSecretFields.includes(field);
        return (
          <label className="field" key={field}>
            <span className="field__label">
              {secretFieldLabel(field)}
              {saved ? <span className="chip chip--ok">Saved</span> : null}
            </span>
            <input
              autoComplete="new-password"
              className="text-input"
              onChange={(event) => {
                const next = { ...secrets };
                if (event.target.value) next[field] = event.target.value;
                else delete next[field];
                setSecrets(next);
              }}
              placeholder={saved ? "Leave blank to keep the saved value" : "Required"}
              required={!saved}
              type="password"
              value={secrets[field] ?? ""}
            />
          </label>
        );
      })}
      {canShare && !editing ? (
        <label className="check-item">
          <input
            checked={shared}
            onChange={(event) => setShared(event.target.checked)}
            type="checkbox"
          />
          <span className="check-item__meta">
            <span className="check-item__label">Make this app available to the deployment</span>
            <span className="check-item__detail">
              Everyone here can sign in with it. Each person still connects their own account, and
              yours stays yours.
            </span>
          </span>
        </label>
      ) : null}
      <p className="field__hint">
        The secret is encrypted before storage and never shown again.
        {editing?.availability === "deployment"
          ? " This app is available to everyone in this deployment."
          : shared
            ? ""
            : " Only you can sign in with this app."}
      </p>
      <div className="form-actions">
        <button className="btn" disabled={pending} onClick={onCancel} type="button">
          Back
        </button>
        {editing?.canManage ? (
          <button
            className="btn"
            disabled={pending}
            onClick={() =>
              onStatus({
                application: editing,
                status: editing.status === "active" ? "disabled" : "active",
              })
            }
            type="button"
          >
            {editing.status === "active" ? "Disable app" : "Enable app"}
          </button>
        ) : null}
        <button className="btn btn--primary" disabled={pending} type="submit">
          {pending ? "Saving…" : "Save app"}
        </button>
      </div>
    </form>
  );
}

/** What was actually connected, read from the connection row the Host returned. */
export function ConnectedFacts({
  connection,
  name,
}: {
  readonly connection: IntegrationConnectionSummary;
  readonly name: string;
}) {
  return (
    <div className="notice notice--accent" role="status">
      <Icon name="check-circle" />
      <span>
        {name} is connected as {integrationAccountTitle(connection)}.
      </span>
    </div>
  );
}
