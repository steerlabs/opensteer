import { useEffect, useState } from "react";
import { DeploymentIdSchema } from "@opensteer/core";
import { type DesktopPlaces } from "../../desktop/places-context.js";
import { useComputerFacts } from "../../desktop/use-computer-facts.js";
import { placeRows, thisComputerLabel } from "../../desktop/places.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import { ErrorNotice } from "../onboarding-card.js";
import { PlaceList } from "./place-list.js";
import { PlaceSignInCard } from "./place-account.js";

/** Places in the switch dialog, checked while open. Choosing or adding one closes it. */
export function PlaceMenuPlaces({
  onClose,
  places,
}: {
  readonly onClose: () => void;
  readonly places: DesktopPlaces;
}) {
  const { bridge, onAddPlace, snapshot } = places;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const computers = snapshot.deployments.filter((row) => row.kind === "personal");
  const facts = useComputerFacts(bridge, computers);
  useEffect(() => {
    const check = () => void bridge.checkDeployments().catch(() => undefined);
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [bridge]);
  const personalIds = new Set<string>(computers.map((row) => row.id));
  const rows = placeRows(snapshot, { thisComputer: thisComputerLabel(), facts }).filter((row) =>
    personalIds.has(row.id),
  );
  const run = (operation: () => Promise<void>, then?: () => void) => {
    setPending(true);
    setError(null);
    void operation()
      .then(then)
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(false));
  };
  const signedIn = snapshot.account.status === "signed-in";
  return (
    <>
      <div className="picker__section place-menu__places">
        <PlaceList
          busy={pending}
          explainCurrent
          label="Your computers"
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
        <PlaceSignInCard
          account={snapshot.account}
          onCancel={() => run(() => bridge.cancel())}
          onSignIn={() => run(() => bridge.signIn())}
          pending={pending}
        />
        {signedIn && snapshot.directoryFailure ? (
          <p className="place-menu__note" role="status">
            Couldn’t refresh your list. Check your connection.{" "}
            <button
              className="link-btn"
              onClick={() => void bridge.checkDeployments().catch(() => undefined)}
              type="button"
            >
              Try again
            </button>
          </p>
        ) : null}
        <ErrorNotice message={error} />
      </div>
      <div className="picker__section">
        <button
          className="picker__row"
          onClick={() => {
            onClose();
            onAddPlace();
          }}
          type="button"
        >
          <span aria-hidden className="picker__check picker__check--icon">
            <Icon name="plus" />
          </span>
          <span className="picker__label">Add a computer or server</span>
        </button>
      </div>
    </>
  );
}
