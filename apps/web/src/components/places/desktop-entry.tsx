import { useState, type FormEvent } from "react";
import { DeploymentIdSchema } from "@opensteer/core";
import {
  DesktopConnectPrivateDeploymentInputSchema,
  type DesktopConnectPrivateDeploymentInput,
} from "@opensteer/protocol/desktop";
import { useComputerFacts } from "../../desktop/use-computer-facts.js";
import { usePlaceChecks, type DesktopPlaces } from "../../desktop/places-context.js";
import { placeRows, thisComputerLabel } from "../../desktop/places.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon, type IconName } from "../icon.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { OptionRow } from "../option-row.js";
import { PlaceList } from "./place-list.js";
import { PlaceAccountFooter, SignOutDialog } from "./place-account.js";

export type ConnectKind = "pairing" | "team";

function EntryRow({
  detail,
  disabled = false,
  icon,
  onClick,
  title,
}: {
  readonly detail: string;
  readonly disabled?: boolean;
  readonly icon: IconName;
  readonly onClick: () => void;
  readonly title: string;
}) {
  return (
    <OptionRow
      as="button"
      detail={detail}
      disabled={disabled}
      framed
      leading={
        <span className="option-row__glyph option-row__glyph--outline">
          <Icon name={icon} />
        </span>
      }
      onClick={onClick}
      title={title}
      trailing={<Icon name="chevron-right" />}
    />
  );
}

function SecondaryPaths({
  onConnect,
  pairing = true,
}: {
  readonly onConnect: (kind: ConnectKind) => void;
  readonly pairing?: boolean;
}) {
  return (
    <p className="desktop-entry__links">
      {pairing ? (
        <>
          <button className="link-btn" onClick={() => onConnect("pairing")} type="button">
            Use a pairing code or address
          </button>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <button className="link-btn" onClick={() => onConnect("team")} type="button">
        Join a team server
      </button>
    </p>
  );
}

/**
 * A new desktop install: set Opensteer up here, or open the one this person
 * already has. Signed in to an Account that lists none yet, it says so and
 * offers the one thing left to do, and keeps checking.
 */
export function DesktopWelcome({
  error,
  onConnect,
  onSetUpHere,
  places,
}: {
  readonly error: string | null;
  readonly onConnect: (kind: ConnectKind) => void;
  readonly onSetUpHere: (() => void) | null;
  readonly places: DesktopPlaces;
}) {
  const { bridge, snapshot } = places;
  const account = snapshot.account;
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  usePlaceChecks(bridge, account.status === "signed-in");
  const run = (operation: () => Promise<void>) => {
    setActionError(null);
    void operation().catch((reason: unknown) => setActionError(actionErrorMessage(reason)));
  };
  const setUpRow = (
    <EntryRow
      detail="Your agent lives and runs here. Best on a Mac that stays on. No account needed."
      disabled={onSetUpHere === null}
      icon="laptop"
      onClick={() => onSetUpHere?.()}
      title="Set up Opensteer on this Mac"
    />
  );

  if (account.status === "signed-in") {
    return (
      <OnboardingCard
        bare
        description={
          snapshot.directoryFailure
            ? "Couldn’t load your list. Check your connection."
            : "Set one up on this Mac, or open Opensteer on the Mac where you set it up. It shows up here by itself."
        }
        live
        title="No Opensteer on this account yet"
      >
        <ErrorNotice message={actionError ?? error} />
        {onSetUpHere ? (
          <button
            className="btn btn--primary onboarding__primary"
            onClick={onSetUpHere}
            type="button"
          >
            Set up Opensteer on this Mac
            <Icon name="arrow-right" />
          </button>
        ) : null}
        {snapshot.directoryFailure ? (
          <button
            className="btn btn--ghost onboarding__back"
            onClick={() => run(() => bridge.checkDeployments())}
            type="button"
          >
            Try again
          </button>
        ) : null}
        <SecondaryPaths onConnect={onConnect} />
        <div className="place-panel">
          <PlaceAccountFooter account={account} onSignOut={() => setSigningOut(true)} />
        </div>
        {signingOut ? (
          <SignOutDialog
            bridge={bridge}
            onClose={() => setSigningOut(false)}
            onConfirm={() => bridge.signOut()}
            snapshot={snapshot}
          />
        ) : null}
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard bare live title="Welcome to Opensteer">
      <ErrorNotice message={actionError ?? error} />
      <div className="desktop-entry__rows">
        {setUpRow}
        {account.available ? (
          account.status === "authorizing" ? (
            <div aria-live="polite" className="place-card" role="status">
              <p className="place-card__title">Finish signing in in your browser</p>
              <p className="place-card__body">This window continues by itself.</p>
              <button
                className="btn btn--small btn--ghost"
                onClick={() => run(() => bridge.cancel())}
                type="button"
              >
                Cancel
              </button>
            </div>
          ) : (
            <EntryRow
              detail="Already have one on another Mac? Sign in to use this Mac with it."
              icon="devices"
              onClick={() => run(() => bridge.signIn())}
              title="Open your Opensteer"
            />
          )
        ) : (
          <EntryRow
            detail="Already have one on another Mac? Use a pairing code from it."
            icon="devices"
            onClick={() => onConnect("pairing")}
            title="Open your Opensteer"
          />
        )}
      </div>
      <SecondaryPaths onConnect={onConnect} pairing={account.available} />
    </OnboardingCard>
  );
}

/**
 * The Opensteers this person can open here, with a notice above them when
 * the one they were in can't open right now and the one move that fixes it.
 */
export function DesktopChooser({
  error,
  notice = null,
  onConnect,
  onSetUpHere,
  places,
}: {
  readonly error: string | null;
  readonly notice?: {
    readonly action: {
      readonly label: string;
      readonly quiet?: boolean;
      readonly run: () => Promise<void>;
    } | null;
    readonly body: string | null;
    readonly signIn: boolean;
    readonly title: string;
  } | null;
  readonly onConnect: (kind: ConnectKind) => void;
  readonly onSetUpHere: (() => void) | null;
  readonly places: DesktopPlaces;
}) {
  const { bridge, snapshot } = places;
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  usePlaceChecks(bridge, true);
  const facts = useComputerFacts(
    bridge,
    snapshot.deployments.filter((row) => row.kind === "personal"),
  );
  const rows = placeRows(snapshot, { thisComputer: thisComputerLabel(), facts });
  const run = (operation: () => Promise<void>) => {
    setPending(true);
    setActionError(null);
    void operation()
      .catch((reason: unknown) => setActionError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };
  const account = snapshot.account;
  const title = notice?.title ?? (rows.length > 1 ? "Choose an Opensteer" : "Open your Opensteer");
  return (
    <OnboardingCard
      bare
      description={
        notice?.body ??
        "This Mac will become one of your devices. You’ll choose what it shares next."
      }
      eyebrow={
        account.status === "signed-in" && account.email
          ? `Signed in as ${account.email}`
          : undefined
      }
      live
      title={title}
    >
      {notice?.action ? (
        <button
          className={
            notice.action.quiet
              ? "btn btn--ghost onboarding__back"
              : "btn btn--primary onboarding__primary"
          }
          disabled={pending}
          onClick={() => run(notice.action!.run)}
          type="button"
        >
          {notice.action.label}
        </button>
      ) : null}
      <ErrorNotice message={actionError ?? error} />
      <div className="place-panel">
        {rows.length > 0 ? (
          <PlaceList
            busy={pending}
            label="Your Opensteers"
            onCheck={() => void bridge.checkDeployments().catch(() => undefined)}
            onOpen={(row) => {
              if (!row.current) {
                run(() => bridge.select({ deploymentId: DeploymentIdSchema.parse(row.id) }));
                return;
              }
              const selected = snapshot.deployments.find(({ id }) => id === row.id);
              if (selected?.source === "account" && account.status !== "signed-in") {
                if (account.available && account.status !== "authorizing")
                  run(() => bridge.signIn());
              } else if (selected?.availableActions.includes("retry")) {
                run(() => bridge.retry());
              }
            }}
            onRemove={(row) =>
              run(() =>
                bridge.removeFromAccount({ deploymentId: DeploymentIdSchema.parse(row.id) }),
              )
            }
            rows={rows}
          />
        ) : null}
        {onSetUpHere ? (
          <button
            className="place-panel__action"
            disabled={pending}
            onClick={onSetUpHere}
            type="button"
          >
            <span aria-hidden className="place-row__check" />
            <span aria-hidden className="place-row__mark">
              <Icon name="laptop" />
            </span>
            <span className="place-row__text">
              <span className="place-row__name">Set up Opensteer on this Mac</span>
              <span className="place-row__detail">Your agent lives and runs here</span>
            </span>
          </button>
        ) : null}
        {!notice?.signIn && account.available && account.status !== "signed-in" ? (
          <button
            className="place-panel__action"
            disabled={pending || account.status === "authorizing"}
            onClick={() => run(() => bridge.signIn())}
            type="button"
          >
            <span aria-hidden className="place-row__check" />
            <span aria-hidden className="place-row__mark">
              <Icon name="devices" />
            </span>
            <span className="place-row__text">
              <span className="place-row__name">
                {account.status === "authorizing"
                  ? "Finish signing in in your browser"
                  : "Open your Opensteer"}
              </span>
              <span className="place-row__detail">Sign in to use this Mac with it</span>
            </span>
          </button>
        ) : null}
        <PlaceAccountFooter account={account} onSignOut={() => setSigningOut(true)} />
      </div>
      <SecondaryPaths onConnect={onConnect} />
      {signingOut ? (
        <SignOutDialog
          bridge={bridge}
          onClose={() => setSigningOut(false)}
          onConfirm={() => bridge.signOut()}
          snapshot={snapshot}
        />
      ) : null}
    </OnboardingCard>
  );
}

/** The secondary ways in: a pairing code with its address, or a team server's address. */
export function DesktopConnect({
  busy,
  error,
  kind,
  onBack,
  onConnect,
}: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly kind: ConnectKind;
  readonly onBack: () => void;
  readonly onConnect: (input: DesktopConnectPrivateDeploymentInput) => void;
}) {
  const [origin, setOrigin] = useState("");
  const [code, setCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const parsed = DesktopConnectPrivateDeploymentInputSchema.safeParse(
      kind === "pairing"
        ? { kind: "personal-pairing", origin: origin.trim(), pairingCode: code.trim() }
        : { kind: "self-hosted", origin: origin.trim() },
    );
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Enter a valid Opensteer address.");
      return;
    }
    setFormError(null);
    onConnect(parsed.data);
  }
  return (
    <OnboardingCard
      bare
      description={
        kind === "pairing"
          ? "On the Mac your Opensteer runs on, create a pairing code in Settings › Devices › Add a device."
          : "Use the HTTPS address your team gave you."
      }
      live
      title={kind === "pairing" ? "Use a pairing code" : "Join a team server"}
    >
      <form className="desktop-entry__form" onSubmit={submit}>
        <label className="field" htmlFor="desktop-connect-origin">
          <span className="field__label">{kind === "pairing" ? "Address" : "Server address"}</span>
          <input
            autoCapitalize="none"
            autoComplete="url"
            autoFocus
            className="text-input"
            disabled={busy}
            id="desktop-connect-origin"
            inputMode="url"
            onChange={(event) => setOrigin(event.target.value)}
            placeholder={
              kind === "pairing"
                ? "https://mac-mini.example.ts.net"
                : "https://opensteer.example.com"
            }
            required
            spellCheck={false}
            type="url"
            value={origin}
          />
        </label>
        {kind === "pairing" ? (
          <label className="field" htmlFor="desktop-connect-code">
            <span className="field__label">Pairing code</span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              className="text-input"
              disabled={busy}
              id="desktop-connect-code"
              onChange={(event) => setCode(event.target.value)}
              placeholder="osp_…"
              required
              spellCheck={false}
              type="text"
              value={code}
            />
            <span className="field__hint">It works once, and expires shortly.</span>
          </label>
        ) : null}
        <ErrorNotice message={formError ?? error} />
        <button className="btn btn--primary" disabled={busy} type="submit">
          {busy ? "Verifying…" : "Connect"}
          {busy ? null : <Icon name="arrow-right" />}
        </button>
      </form>
      <button className="btn btn--ghost onboarding__back" onClick={onBack} type="button">
        <Icon name="arrow-left" />
        Back
      </button>
    </OnboardingCard>
  );
}
