import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  cloudComputerWebsite,
  cloudWords,
  homesChooserTitle,
  homesListTitle,
} from "@opensteer/client/computers";
import { remoteAccessOnWhenSignedInStart } from "@opensteer/client/host";
import { useCloudComputer } from "@opensteer/client/react";
import { DeploymentIdSchema } from "@opensteer/core";
import {
  DesktopConnectPrivateDeploymentInputSchema,
  type DesktopConnectPrivateDeploymentInput,
} from "@opensteer/protocol/desktop";
import { useComputerFacts } from "../../desktop/use-computer-facts.js";
import { usePlaceChecks, type DesktopPlaces } from "../../desktop/places-context.js";
import { placeRows, thisComputerLabel } from "../../desktop/places.js";
import { act, failureWords } from "../use-action.js";
import { Dialog } from "../dialog.js";
import { Icon, type IconName } from "../icon.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { OptionRow } from "../option-row.js";
import { PlaceList } from "./place-list.js";
import { PlaceAccountFooter, SignOutDialog } from "./place-account.js";
import {
  SetupSteps,
  usePlaceCloudComputers,
  usePlaceWorkBadges,
} from "../settings/sections/work-home.js";
import { cloudComputerAccountFor } from "../settings/sections/cloud-computer.js";

export type ConnectKind = "pairing" | "address";

/**
 * Which question started this Mac's Opensteer: "Where should your Opensteer live? › On this
 * Mac" (its setup turns Remote access on), "Use without an account" (it is never asked to sign
 * in), or anything else, such as a separate Opensteer (neither).
 */
export type StartedFrom = "on-this-mac" | "without-account" | "other";
export type SetUpHere = (name: string | undefined, from: StartedFrom) => void;

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

/** A Home at its own address, under the keyless welcome's two rows. */
function SecondaryPaths({ onConnect }: { readonly onConnect: (kind: ConnectKind) => void }) {
  return (
    <p className="desktop-entry__links">
      <button className="link-btn" onClick={() => onConnect("address")} type="button">
        Add a Home by address
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
  title,
}: {
  readonly detail: string;
  readonly disabled: boolean;
  readonly name: string | null;
  readonly onRename: (name: string) => void;
  readonly onStart: () => void;
  /** What the row is called; by default "Start Opensteer on this Mac". */
  readonly title?: string;
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
        title={title ?? `Start Opensteer on ${thisComputerLabel().replace(/^This /u, "this ")}`}
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

type WelcomeView = "door" | "without-account" | "other-ways";

/**
 * The first screen with nothing on this Mac yet. The Opensteer account is the front door: one
 * primary action, Sign in. Using Opensteer without an account stays a small link, and so do
 * the other ways in (a pairing code, an address). A build with no account to sign in to keeps
 * the welcome it always had. Signed in, the account decides what comes next.
 */
export function DesktopWelcome({
  error,
  onConnect,
  onSetUpHere,
  places,
}: {
  readonly error: string | null;
  readonly onConnect: (kind: ConnectKind) => void;
  readonly onSetUpHere: SetUpHere | null;
  readonly places: DesktopPlaces;
}) {
  const { bridge, snapshot } = places;
  const account = snapshot.account;
  const [actionError, setActionError] = useState<string | null>(null);
  const [chosenName, setChosenName] = useState<string | null>(null);
  const [view, setView] = useState<WelcomeView>("door");
  const macName = chosenName ?? snapshot.personalSetup?.name ?? null;
  usePlaceChecks(bridge, account.status === "signed-in");
  const run = (operation: () => Promise<void>) => {
    setActionError(null);
    void act(null, { label: "do this", done: "done" }, operation).catch((reason: unknown) =>
      setActionError(failureWords(reason)),
    );
  };
  const startHere = (from: StartedFrom, detail: string, title?: string) => (
    <StartHere
      detail={detail}
      disabled={onSetUpHere === null}
      name={macName}
      onRename={setChosenName}
      onStart={() => onSetUpHere?.(chosenName ?? undefined, from)}
      {...(title ? { title } : {})}
    />
  );

  if (view === "other-ways")
    return <OtherWaysIn onBack={() => setView("door")} onConnect={onConnect} />;

  if (account.status === "signed-in") {
    return (
      <DesktopWhere
        error={actionError ?? error}
        onOtherWays={() => setView("other-ways")}
        places={places}
        run={run}
        startHere={
          onSetUpHere
            ? startHere("on-this-mac", "Free. Works while this Mac is awake.", "On this Mac")
            : null
        }
      />
    );
  }

  // macOS refused Opensteer this Mac's keychain (locked, a login from another computer, a
  // managed Mac): the account can't keep a sign-in, so it reads as unavailable with an error.
  // Saying so, and how to try again, rather than a welcome with Sign in silently gone.
  if (!account.available && account.status === "error") {
    return (
      <OnboardingCard
        bare
        description="Opensteer keeps your sign-in in this Mac’s keychain, and the keychain isn’t letting it in. Unlock it in Keychain Access, or log in at the Mac itself instead of from another computer, then try again."
        live
        title="Opensteer can’t use this Mac’s keychain"
      >
        <ErrorNotice message={actionError ?? error} />
        <button
          className="btn btn--primary onboarding__primary"
          onClick={() => run(() => bridge.signIn())}
          type="button"
        >
          Try again
        </button>
      </OnboardingCard>
    );
  }

  // A build with no Opensteer account to sign in to: the welcome as it always was.
  if (!account.available) {
    return (
      <OnboardingCard
        bare
        description="Your AI agent, working on your computer."
        live
        title="Welcome to Opensteer"
      >
        <ErrorNotice message={actionError ?? error} />
        <div className="desktop-entry__rows">
          {startHere("other", "Your agent lives and works here. No account needed.")}
          <EntryRow
            detail="It’s already running on another computer. Use its pairing code."
            icon="devices"
            onClick={() => onConnect("pairing")}
            title="Connect to my Opensteer"
          />
        </div>
        <SecondaryPaths onConnect={onConnect} />
      </OnboardingCard>
    );
  }

  if (view === "without-account") {
    return (
      <OnboardingCard
        bare
        description="Opensteer runs on this Mac. You can sign in to your Opensteer account later, in Settings."
        live
        title="Use Opensteer without an account"
      >
        <ErrorNotice message={actionError ?? error} />
        <div className="desktop-entry__rows">
          {startHere("without-account", "Your agent lives and works here. No account needed.")}
        </div>
        <button
          className="btn btn--ghost onboarding__back"
          onClick={() => setView("door")}
          type="button"
        >
          <Icon name="arrow-left" />
          Back
        </button>
      </OnboardingCard>
    );
  }

  return (
    <OnboardingCard
      bare
      description="Sign in with your Opensteer account. Your phone and connected agents can then reach your Opensteer from anywhere."
      live
      title="Welcome to Opensteer"
    >
      <ErrorNotice message={actionError ?? error} />
      {account.status === "authorizing" ? (
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
        <button
          className="btn btn--primary onboarding__primary"
          onClick={() => run(() => bridge.signIn())}
          type="button"
        >
          Sign in
        </button>
      )}
      <p className="desktop-entry__links">
        <button className="link-btn" onClick={() => setView("without-account")} type="button">
          Use without an account
        </button>
        <span aria-hidden>·</span>
        <button className="link-btn" onClick={() => setView("other-ways")} type="button">
          Other ways in
        </button>
      </p>
    </OnboardingCard>
  );
}

/** A pairing code or an address: the ways in that aren't the Opensteer account. */
function OtherWaysIn({
  children,
  onBack,
  onConnect,
}: {
  readonly children?: ReactNode;
  readonly onBack: () => void;
  readonly onConnect: (kind: ConnectKind) => void;
}) {
  return (
    <OnboardingCard bare live title="Other ways in">
      <div className="desktop-entry__rows">
        <EntryRow
          detail="From the Mac your Opensteer runs on."
          icon="devices"
          onClick={() => onConnect("pairing")}
          title="Use a pairing code"
        />
        <EntryRow
          detail="An Opensteer you run on your own server."
          icon="server"
          onClick={() => onConnect("address")}
          title="Add a Home by address"
        />
        {children}
      </div>
      <button className="btn btn--ghost onboarding__back" onClick={onBack} type="button">
        <Icon name="arrow-left" />
        Back
      </button>
    </OnboardingCard>
  );
}

/**
 * Signed in, and the account has no Opensteer yet: where should it live? On this Mac (free,
 * while it is awake), or on an Opensteer Cloud Computer at the price checkout sells now (always
 * on; this Mac becomes one of its devices). A list that couldn't be read may hold one, so the
 * way on is to read it again, never to start a second one beside it.
 */
function DesktopWhere({
  error,
  onOtherWays,
  places,
  run,
  startHere,
}: {
  readonly error: string | null;
  readonly onOtherWays: () => void;
  readonly places: DesktopPlaces;
  readonly run: (operation: () => Promise<void>) => void;
  readonly startHere: ReactNode;
}) {
  const { bridge, snapshot } = places;
  const account = snapshot.account;
  const [signingOut, setSigningOut] = useState(false);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const cloudAccount = useMemo(() => cloudComputerAccountFor(bridge), [bridge]);
  const cloud = useCloudComputer(cloudAccount);
  const portalOrigin = account.portalOrigin ?? null;
  const refresh = cloud.refresh;
  // Back from checkout in the browser: the account's answer is read again.
  useEffect(() => {
    if (!refresh) return;
    const again = () => void refresh();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);
  const screen = cloud.screen;
  const readyId =
    screen.kind === "computer" || screen.kind === "preparing" ? screen.computer.deploymentId : null;
  // Once the account has set the Cloud Computer up for this person, the list has it.
  useEffect(() => {
    if (readyId) void bridge.checkDeployments().catch(() => undefined);
  }, [bridge, readyId]);
  const footer = (
    <>
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
    </>
  );
  const eyebrow = account.email ? `Signed in as ${account.email}` : undefined;

  if (snapshot.directoryFailure !== null) {
    return (
      <OnboardingCard
        bare
        description="Check your connection, then try again."
        live
        title="Couldn’t load your Opensteers"
      >
        <ErrorNotice message={error} />
        <button
          className="btn btn--primary onboarding__primary"
          onClick={() => run(() => bridge.checkDeployments())}
          type="button"
        >
          Try again
        </button>
        {footer}
      </OnboardingCard>
    );
  }

  if (screen.kind === "preparing" || screen.kind === "computer") {
    return (
      <OnboardingCard
        bare
        description={
          screen.kind === "preparing"
            ? cloudWords("cloud.preparing.footer")
            : cloudWords("cloud.ready.notListed")
        }
        {...(eyebrow ? { eyebrow } : {})}
        live
        title={
          screen.kind === "preparing"
            ? cloudWords("cloud.preparing.title")
            : cloudWords("cloud.ready.title")
        }
      >
        {screen.kind === "preparing" && screen.computer.steps ? (
          <SetupSteps steps={screen.computer.steps} />
        ) : null}
        {footer}
      </OnboardingCard>
    );
  }

  const offer = screen.kind === "offer" ? screen : null;
  const waiting = offer?.waiting ?? false;
  // Checkout counts as opened only once the system browser took the address.
  const openCheckout = () => {
    if (!portalOrigin) return;
    setOpenFailure(null);
    void bridge.openExternalUrl({ url: cloudComputerWebsite(portalOrigin, "checkout") }).then(
      () => cloud.checkoutOpened?.(),
      () => setOpenFailure("Your browser couldn’t open the Opensteer website. Try again."),
    );
  };
  const cloudDetail =
    screen.kind === "loading"
      ? "Checking…"
      : offer?.plan
        ? `${offer.plan.line}. Always on. This Mac can be one of its devices.`
        : cloudWords("cloud.notForSale");
  return (
    <OnboardingCard
      bare
      description="Your browser profiles, apps, plugins, tasks and rules live in one Home. You can add devices to it later."
      {...(eyebrow ? { eyebrow } : {})}
      live
      title="Where should your Opensteer live?"
    >
      <ErrorNotice message={openFailure ?? error} />
      {waiting ? (
        <div aria-live="polite" className="place-card" role="status">
          <p className="place-card__title">{cloudWords("cloud.checkoutWaiting.title")}</p>
          <p className="place-card__body">{cloudWords("cloud.checkoutWaiting.detail")}</p>
          <button className="btn btn--small btn--ghost" onClick={openCheckout} type="button">
            {cloudWords("cloud.checkoutAgain")}
          </button>
          {/* A person can always turn back: the watch stops and both choices return. */}
          <button
            className="btn btn--small btn--ghost"
            onClick={() => cloud.stopFollowingCheckout?.()}
            type="button"
          >
            Choose something else
          </button>
        </div>
      ) : (
        <div className="desktop-entry__rows">
          {startHere}
          {startHere && remoteAccessOnWhenSignedInStart ? (
            <p className="desktop-entry__note">
              Your phone and connected agents can reach it from anywhere. You can turn this off in
              Settings.
            </p>
          ) : null}
          <EntryRow
            detail={cloudDetail}
            disabled={!offer?.plan || !portalOrigin}
            icon="cloud"
            onClick={openCheckout}
            title="On an Opensteer Cloud Computer"
          />
        </div>
      )}
      <p className="desktop-entry__links">
        <span>Started Opensteer on another Mac without an account?</span>{" "}
        <button className="link-btn" onClick={onOtherWays} type="button">
          Other ways in
        </button>
      </p>
      {footer}
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
  readonly onSetUpHere: SetUpHere | null;
  readonly places: DesktopPlaces;
}) {
  const { bridge, snapshot } = places;
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [confirmingStart, setConfirmingStart] = useState(false);
  const [otherWays, setOtherWays] = useState(false);
  usePlaceChecks(bridge, true);
  const facts = useComputerFacts(places.facts, snapshot.deployments);
  const work = usePlaceWorkBadges(bridge);
  const cloud = usePlaceCloudComputers(bridge);
  const rows = placeRows(snapshot, { thisComputer: thisComputerLabel(), facts, work, cloud });
  const thisMac = thisComputerLabel().replace(/^This /u, "this ");
  // Opensteers elsewhere this person could mean instead of a new one here. An
  // Account listing that can't be opened right now still counts: its kind is
  // unknown, and it may well be their Opensteer.
  const others = [
    ...snapshot.deployments.filter((row) => !row.onThisComputer).map(({ name }) => name),
    ...snapshot.unavailable.map(({ name }) => name),
  ];
  // A list that couldn't be read may hold one too, so Start waits for it.
  const startHere = snapshot.directoryFailure === null ? onSetUpHere : null;
  const run = (operation: () => Promise<void>) => {
    setPending(true);
    setActionError(null);
    void act(null, { label: "do this", done: "done" }, operation)
      .catch((reason: unknown) => setActionError(failureWords(reason)))
      .finally(() => setPending(false));
  };
  const account = snapshot.account;
  const title = notice?.title ?? (rows.length > 1 ? homesChooserTitle : "Open your Opensteer");
  const startSeparate = startHere ? (
    <EntryRow
      detail={
        others.length > 0
          ? "A new, empty Opensteer here, with its own agent and tasks."
          : "Your agent lives and works here."
      }
      disabled={pending}
      icon="laptop"
      onClick={() => (others.length > 0 ? setConfirmingStart(true) : startHere(undefined, "other"))}
      title={
        others.length > 0
          ? `Start a separate Opensteer on ${thisMac}`
          : `Start Opensteer on ${thisMac}`
      }
    />
  ) : null;
  if (otherWays && !confirmingStart)
    return (
      <OtherWaysIn onBack={() => setOtherWays(false)} onConnect={onConnect}>
        {startSeparate}
      </OtherWaysIn>
    );
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
            label={homesListTitle}
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
      <p className="desktop-entry__links">
        <button className="link-btn" onClick={() => setOtherWays(true)} type="button">
          Other ways in
        </button>
      </p>
      {confirmingStart && startHere ? (
        <StartSeparateDialog
          onClose={() => setConfirmingStart(false)}
          onStart={() => {
            setConfirmingStart(false);
            startHere(undefined, "other");
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
        : { kind: "address", origin: origin.trim() },
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
          ? "On the Mac your Opensteer runs on, create a pairing code in Settings › Devices › Add a device › Advanced."
          : "The address of an Opensteer you run on your own server."
      }
      live
      title={kind === "pairing" ? "Use a pairing code" : "Add a Home by address"}
    >
      <form className="desktop-entry__form" onSubmit={submit}>
        <label className="field" htmlFor="desktop-connect-origin">
          <span className="field__label">{kind === "pairing" ? "Address" : "Home address"}</span>
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
              kind === "pairing" ? "https://mac-mini.example.ts.net" : "https://home.example.com"
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

/** "Home", "Home or Studio", "Home, Studio or Lab"; past three, "your other Opensteers". */
function namesInWords(names: readonly string[]): string {
  if (names.length > 3) return "your other Opensteers";
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
