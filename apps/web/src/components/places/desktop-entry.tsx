import { deploymentPolicy } from "@opensteer/core";
import { useId, useRef, useState, type FormEvent } from "react";
import { DeploymentIdSchema } from "@opensteer/core";
import {
  DesktopConnectPrivateDeploymentInputSchema,
  type DesktopConnectPrivateDeploymentInput,
} from "@opensteer/protocol/desktop";
import { useComputerFacts } from "../../desktop/use-computer-facts.js";
import { usePlaceChecks, type DesktopPlaces } from "../../desktop/places-context.js";
import { placeRows, thisComputerLabel } from "../../desktop/places.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { Dialog } from "../dialog.js";
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
            Use a pairing code
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
 * Starting an Opensteer on this Mac, with the name it will have. The name is
 * fixed when this computer's Opensteer is created, so it is chosen here, before.
 */
function StartHere({
  detail,
  disabled,
  name,
  onRename,
  onStart,
}: {
  readonly detail: string;
  readonly disabled: boolean;
  readonly name: string | null;
  readonly onRename: (name: string) => void;
  readonly onStart: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape closes the field, and the blur that follows must not save it.
  const discarding = useRef(false);
  const save = () => {
    const next = discarding.current ? "" : (draft?.trim() ?? "");
    discarding.current = false;
    if (next) onRename(next);
    setDraft(null);
  };
  return (
    <div className="desktop-entry__setup">
      <OptionRow
        as="button"
        className="desktop-entry__setup-go"
        detail={detail}
        disabled={disabled || draft !== null}
        leading={
          <span className="option-row__glyph">
            <Icon name="laptop" />
          </span>
        }
        onClick={onStart}
        title={`Start Opensteer on ${thisComputerLabel().replace(/^This /u, "this ")}`}
        trailing={<Icon name="chevron-right" />}
      />
      {name ? (
        draft === null ? (
          <div className="desktop-entry__name">
            <span className="desktop-entry__name-label">Name</span>
            <span className="desktop-entry__name-value">{name}</span>
            <button
              aria-label={`Rename ${name}`}
              className="link-btn"
              disabled={disabled}
              onClick={() => setDraft(name)}
              type="button"
            >
              Rename
            </button>
          </div>
        ) : (
          <form
            className="desktop-entry__name"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <label className="desktop-entry__name-label" htmlFor="desktop-entry-name">
              Name
            </label>
            <input
              autoFocus
              className="desktop-entry__name-input"
              id="desktop-entry-name"
              maxLength={120}
              onBlur={save}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  discarding.current = true;
                  event.currentTarget.blur();
                }
              }}
              spellCheck={false}
              value={draft}
            />
            <button
              className="link-btn"
              onMouseDown={(event) => event.preventDefault()}
              type="submit"
            >
              Done
            </button>
          </form>
        )
      ) : null}
    </div>
  );
}

export function DesktopWelcome({
  error,
  onConnect,
  onSetUpHere,
  places,
}: {
  readonly error: string | null;
  readonly onConnect: (kind: ConnectKind) => void;
  readonly onSetUpHere: ((name?: string) => void) | null;
  readonly places: DesktopPlaces;
}) {
  const { bridge, snapshot } = places;
  const account = snapshot.account;
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [chosenName, setChosenName] = useState<string | null>(null);
  const macName = chosenName ?? snapshot.personalSetup?.name ?? null;
  usePlaceChecks(bridge, account.status === "signed-in");
  const run = (operation: () => Promise<void>) => {
    setActionError(null);
    void operation().catch((reason: unknown) => setActionError(actionErrorMessage(reason)));
  };
  const start = () => onSetUpHere?.(chosenName ?? undefined);

  if (account.status === "signed-in") {
    // A list that couldn't be read may hold an Opensteer, so the way on is to
    // read it again, never to start a second one beside it.
    const listFailed = snapshot.directoryFailure !== null;
    return (
      <OnboardingCard
        bare
        description={
          listFailed
            ? "Check your connection, then try again."
            : "If yours was started without an account, connect with a pairing code from the computer it runs on."
        }
        live
        title={listFailed ? "Couldn’t load your Opensteers" : "No Opensteer on this account"}
      >
        <ErrorNotice message={actionError ?? error} />
        {listFailed ? (
          <button
            className="btn btn--primary onboarding__primary"
            onClick={() => run(() => bridge.checkDeployments())}
            type="button"
          >
            Try again
          </button>
        ) : (
          <div className="desktop-entry__rows">
            <EntryRow
              detail="From the computer your Opensteer runs on."
              icon="devices"
              onClick={() => onConnect("pairing")}
              title="Connect with a pairing code"
            />
            {onSetUpHere ? (
              <StartHere
                detail="Your agent lives and works here."
                disabled={false}
                name={macName}
                onRename={setChosenName}
                onStart={start}
              />
            ) : null}
          </div>
        )}
        <SecondaryPaths onConnect={onConnect} pairing={false} />
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
    <OnboardingCard
      bare
      description="Your AI agent, working on your computer."
      live
      title="Welcome to Opensteer"
    >
      <ErrorNotice message={actionError ?? error} />
      <div className="desktop-entry__rows">
        <StartHere
          detail="Your agent lives and works here. No account needed."
          disabled={onSetUpHere === null}
          name={macName}
          onRename={setChosenName}
          onStart={start}
        />
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
              detail="It’s already running on another computer. Sign in to continue."
              icon="devices"
              onClick={() => run(() => bridge.signIn())}
              title="Connect to my Opensteer"
            />
          )
        ) : (
          <EntryRow
            detail="It’s already running on another computer. Use its pairing code."
            icon="devices"
            onClick={() => onConnect("pairing")}
            title="Connect to my Opensteer"
          />
        )}
      </div>
      <SecondaryPaths onConnect={onConnect} pairing={account.available} />
    </OnboardingCard>
  );
}

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
  readonly onSetUpHere: ((name?: string) => void) | null;
  readonly places: DesktopPlaces;
}) {
  const { bridge, snapshot } = places;
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [confirmingStart, setConfirmingStart] = useState(false);
  usePlaceChecks(bridge, true);
  const facts = useComputerFacts(
    places.facts,
    snapshot.deployments.filter((row) => deploymentPolicy({ kind: row.kind }).services.personal),
  );
  const rows = placeRows(snapshot, { thisComputer: thisComputerLabel(), facts });
  const thisMac = thisComputerLabel().replace(/^This /u, "this ");
  // Opensteers elsewhere that this person could mean instead of a new one here.
  const others = snapshot.deployments
    .filter((row) => deploymentPolicy({ kind: row.kind }).services.personal && !row.onThisComputer)
    .map(({ name }) => name);
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
                  : "Connect to my Opensteer"}
              </span>
              <span className="place-row__detail">Sign in to see your Opensteers</span>
            </span>
          </button>
        ) : null}
        <PlaceAccountFooter account={account} onSignOut={() => setSigningOut(true)} />
      </div>
      {onSetUpHere ? (
        <p className="desktop-entry__links">
          <button
            className="link-btn"
            disabled={pending}
            onClick={() => (others.length > 0 ? setConfirmingStart(true) : onSetUpHere())}
            type="button"
          >
            {others.length > 0
              ? `Start a separate Opensteer on ${thisMac}`
              : `Start Opensteer on ${thisMac}`}
          </button>
        </p>
      ) : null}
      <SecondaryPaths onConnect={onConnect} />
      {confirmingStart && onSetUpHere ? (
        <StartSeparateDialog
          onClose={() => setConfirmingStart(false)}
          onStart={() => {
            setConfirmingStart(false);
            onSetUpHere();
          }}
          others={others}
        />
      ) : null}
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

/** "Home", "Home or Studio", "Home, Studio or Lab". */
function namesInWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)!}`;
}

/**
 * Starting an Opensteer here while the person already has one elsewhere is
 * rarely what they meant, so it says what it makes before it makes it.
 */
function StartSeparateDialog({
  onClose,
  onStart,
  others,
}: {
  readonly onClose: () => void;
  readonly onStart: () => void;
  readonly others: readonly string[];
}) {
  const titleId = useId();
  const thisMac = thisComputerLabel().replace(/^This /u, "this ");
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn btn--primary" onClick={onStart} type="button">
            Start separate Opensteer
          </button>
        </>
      }
      labelledBy={titleId}
      onClose={onClose}
      title={<span id={titleId}>Start a separate Opensteer?</span>}
    >
      <p>
        This makes a new, empty Opensteer on {thisMac}, with its own agent and tasks. Nothing from{" "}
        {namesInWords(others)} comes with it.
      </p>
    </Dialog>
  );
}
