import { useEffect, useState } from "react";
import { DeploymentIdSchema } from "@opensteer/core";
import { homesListTitle } from "@opensteer/client/computers";
import { type DesktopPlaces } from "../../desktop/places-context.js";
import { useComputerFacts } from "../../desktop/use-computer-facts.js";
import { placeRows, thisComputerLabel } from "../../desktop/places.js";
import { act, failureWords } from "../use-action.js";
import { Icon } from "../icon.js";
import { ErrorNotice } from "../onboarding-card.js";
import { PlaceList } from "./place-list.js";
import { PlaceSignInCard } from "./place-account.js";
import { usePlaceCloudComputers } from "../settings/sections/cloud-computer.js";

/**
 * Places in the switch dialog, checked while open. Choosing or adding one closes it. With
 * `severalOnly` (the sidebar's menu) it is a switcher, shown only when there is more than one
 * Opensteer to switch between; Settings shows it always.
 */
export function PlaceMenuPlaces({
  onClose,
  places,
  severalOnly = false,
}: {
  readonly onClose: () => void;
  readonly places: DesktopPlaces;
  readonly severalOnly?: boolean;
}) {
  const computers = places.snapshot.deployments.filter((row) => row.kind === "personal");
  // Nothing to switch between: nothing is mounted, read or listened for.
  if (severalOnly && computers.length <= 1) return null;
  return <PlaceMenuBody computers={computers} onClose={onClose} places={places} />;
}

function PlaceMenuBody({
  computers,
  onClose,
  places,
}: {
  readonly computers: DesktopPlaces["snapshot"]["deployments"];
  readonly onClose: () => void;
  readonly places: DesktopPlaces;
}) {
  const { bridge, facts: factsStore, onAddPlace, snapshot } = places;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const facts = useComputerFacts(factsStore, computers);
  const cloud = usePlaceCloudComputers(bridge);
  useEffect(() => {
    const check = () => void bridge.checkDeployments().catch(() => undefined);
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [bridge]);
  const personalIds = new Set<string>(computers.map((row) => row.id));
  const rows = placeRows(snapshot, {
    thisComputer: thisComputerLabel(),
    facts,
    cloud,
  }).filter((row) => personalIds.has(row.id));
  const run = (operation: () => Promise<void>, then?: () => void) => {
    setPending(true);
    setError(null);
    void act(
      null,
      { label: "change this place", done: "changed", happened: "this place changed" },
      operation,
    )
      .then(then)
      .catch((reason: unknown) => setError(failureWords(reason)))
      .finally(() => setPending(false));
  };
  const signedIn = snapshot.account.status === "signed-in";
  return (
    <div className="picker__section place-menu__places">
      {/* A failed refresh says so on this line, so it never moves the menu open above it. */}
      <div className="picker__heading place-menu__heading">
        <span aria-hidden>{homesListTitle}</span>
        {signedIn && snapshot.directoryFailure ? (
          <span
            className="place-menu__note"
            role="status"
            title="Couldn’t refresh your list. Check your connection."
          >
            Couldn’t refresh ·{" "}
            <button
              className="link-btn"
              onClick={() => void bridge.checkDeployments().catch(() => undefined)}
              type="button"
            >
              Try again
            </button>
          </span>
        ) : null}
      </div>
      <PlaceList
        busy={pending}
        explainCurrent
        label={homesListTitle}
        onCheck={() => void bridge.checkDeployments().catch(() => undefined)}
        onOpen={(row) => {
          if (row.current) {
            onClose();
            return;
          }
          run(() => bridge.select({ deploymentId: DeploymentIdSchema.parse(row.id) }), onClose);
        }}
        onRemove={(row) =>
          run(() => bridge.removeFromAccount({ deploymentId: DeploymentIdSchema.parse(row.id) }))
        }
        rows={rows}
      />
      <button
        className="place-panel__action"
        onClick={() => {
          onClose();
          onAddPlace();
        }}
        type="button"
      >
        <span aria-hidden className="place-row__check" />
        <span aria-hidden className="place-row__mark">
          <Icon name="plus" />
        </span>
        <span className="place-row__name">Add a computer or server</span>
      </button>
      <PlaceSignInCard
        account={snapshot.account}
        onCancel={() => run(() => bridge.cancel())}
        onSignIn={() => run(() => bridge.signIn())}
        pending={pending}
      />
      <ErrorNotice message={error} />
    </div>
  );
}
