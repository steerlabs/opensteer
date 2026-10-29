import { useState } from "react";
import { DeploymentIdSchema } from "@opensteer/core";
import { usePlaceChecks, type DesktopPlaces } from "../../desktop/places-context.js";
import { placeRows, thisComputerLabel } from "../../desktop/places.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { PlaceList } from "./place-list.js";
import { PlaceAccountFooter, PlaceSignInCard, SignOutDialog } from "./place-account.js";

/**
 * The first thing a new person sees: one obvious way to start, on this
 * computer and without an account, and the way back in for someone who
 * already uses Opensteer elsewhere. Nothing here asks a person to know what
 * kind of thing they are creating.
 */
export function DesktopWelcome({
  error,
  onAdd,
  onStart,
  places,
}: {
  readonly error: string | null;
  readonly onAdd: () => void;
  readonly onStart: (() => void) | null;
  readonly places: DesktopPlaces;
}) {
  const { bridge, snapshot } = places;
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const here = thisComputerLabel().replace(/^This /u, "this ");
  // Signed in with nothing listed yet: keep looking, so places added on
  // another device appear here without a restart.
  usePlaceChecks(bridge, snapshot.account.status === "signed-in");
  const run = (operation: () => Promise<void>) => {
    setActionError(null);
    void operation().catch((reason: unknown) => setActionError(actionErrorMessage(reason)));
  };
  const account = snapshot.account;
  return (
    <OnboardingCard
      bare
      description={`Your agents work on a computer. Start with ${here}: no account needed, and your files stay here.`}
      live
      title="Welcome to Opensteer"
    >
      <ErrorNotice message={actionError ?? error} />
      {onStart ? (
        <button className="btn btn--primary onboarding__primary" onClick={onStart} type="button">
          Start on {here}
          <Icon name="arrow-right" />
        </button>
      ) : null}
      {account.available && account.status !== "signed-in" ? (
        <div className="desktop-welcome__account">
          {account.status === "authorizing" ? (
            <PlaceSignInCard
              account={account}
              onCancel={() => run(() => bridge.cancel())}
              onSignIn={() => run(() => bridge.signIn())}
            />
          ) : (
            <>
              <p className="onboarding__note">Already use Opensteer on another computer?</p>
              <button className="btn" onClick={() => run(() => bridge.signIn())} type="button">
                Sign in
              </button>
            </>
          )}
        </div>
      ) : null}
      {account.status === "signed-in" ? (
        <div className="desktop-welcome__account">
          {snapshot.directoryFailure ? (
            <p className="onboarding__note" role="status">
              Couldn’t load your list. Check your connection.{" "}
              <button
                className="link-btn"
                onClick={() => void bridge.checkDeployments().catch(() => undefined)}
                type="button"
              >
                Try again
              </button>
            </p>
          ) : (
            <p className="onboarding__note">
              Nothing is in your account yet. Start here, or add a computer or server.
            </p>
          )}
          <div className="place-panel">
            <PlaceAccountFooter account={account} onSignOut={() => setSigningOut(true)} />
          </div>
        </div>
      ) : null}
      <div className="onboarding__rule" />
      <p className="onboarding__switch">
        <button onClick={onAdd} type="button">
          Connect to a server or another computer
        </button>
      </p>
      {signingOut ? (
        <SignOutDialog onClose={() => setSigningOut(false)} onConfirm={() => bridge.signOut()} />
      ) : null}
    </OnboardingCard>
  );
}

/**
 * The full window shown when no place is open: the same list as the sidebar's
 * place menu, checked while it is on screen, with a notice above it when the
 * place a person was in cannot open right now and the one move that fixes it.
 */
export function DesktopPlaceChooser({
  error,
  notice = null,
  onSetUpThisComputer,
  places,
}: {
  readonly error: string | null;
  readonly notice?: {
    readonly action: {
      readonly label: string;
      /** A way out rather than the way forward, drawn quietly. */
      readonly quiet?: boolean;
      readonly run: () => Promise<void>;
    } | null;
    readonly body: string | null;
    /** The notice is itself the sign-in, so the list's own sign-in card stays away. */
    readonly signIn: boolean;
    readonly title: string;
  } | null;
  readonly onSetUpThisComputer: (() => void) | null;
  readonly places: DesktopPlaces;
}) {
  const { bridge, cloudDeploymentIds, onAddPlace, snapshot } = places;
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  usePlaceChecks(bridge, true);
  const here = thisComputerLabel();
  const rows = placeRows(snapshot, { cloudDeploymentIds, thisComputer: here });
  const run = (operation: () => Promise<void>) => {
    setPending(true);
    setActionError(null);
    void operation()
      .catch((reason: unknown) => setActionError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };
  const check = () => void bridge.checkDeployments().catch(() => undefined);
  return (
    <OnboardingCard bare live title={notice?.title ?? "Where do you want to work?"}>
      {notice?.body ? <p className="onboarding__note">{notice.body}</p> : null}
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
            label="Your computers and servers"
            onCheck={check}
            onOpen={(row) => {
              if (!row.current) {
                run(() => bridge.select({ deploymentId: DeploymentIdSchema.parse(row.id) }));
                return;
              }
              // The place a person was in, left unopened: choosing it again
              // asks for what it waits on — the Account, or another attempt.
              const selected = snapshot.deployments.find(({ id }) => id === row.id);
              if (selected?.source === "account" && snapshot.account.status !== "signed-in") {
                if (snapshot.account.available && snapshot.account.status !== "authorizing") {
                  run(() => bridge.signIn());
                }
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
        {onSetUpThisComputer ? (
          <button
            className="place-panel__action"
            disabled={pending}
            onClick={onSetUpThisComputer}
            type="button"
          >
            <span aria-hidden className="place-row__check" />
            <span aria-hidden className="place-row__mark">
              <Icon name="laptop" />
            </span>
            <span className="place-row__text">
              <span className="place-row__name">{here}</span>
              <span className="place-row__detail">Set up Opensteer here too</span>
            </span>
          </button>
        ) : null}
        {notice?.signIn ? null : (
          <PlaceSignInCard
            account={snapshot.account}
            onCancel={() => run(() => bridge.cancel())}
            onSignIn={() => run(() => bridge.signIn())}
            pending={pending}
          />
        )}
        {snapshot.account.status === "signed-in" && snapshot.directoryFailure ? (
          <p className="place-menu__note" role="status">
            Couldn’t refresh your list. Check your connection.{" "}
            <button className="link-btn" onClick={check} type="button">
              Try again
            </button>
          </p>
        ) : null}
        <button
          className="place-panel__action"
          disabled={pending}
          onClick={onAddPlace}
          type="button"
        >
          <span aria-hidden className="place-row__check" />
          <span aria-hidden className="place-row__mark">
            <Icon name="plus" />
          </span>
          <span className="place-row__text">
            <span className="place-row__name">Add a computer or server</span>
          </span>
        </button>
        <PlaceAccountFooter account={snapshot.account} onSignOut={() => setSigningOut(true)} />
      </div>
      {signingOut ? (
        <SignOutDialog onClose={() => setSigningOut(false)} onConfirm={() => bridge.signOut()} />
      ) : null}
    </OnboardingCard>
  );
}
