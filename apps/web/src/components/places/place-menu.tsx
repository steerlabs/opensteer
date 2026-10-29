import { useState } from "react";
import { DeploymentIdSchema } from "@opensteer/core";
import { usePlaceChecks, type DesktopPlaces } from "../../desktop/places-context.js";
import { placeRows, thisComputerLabel } from "../../desktop/places.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import { ErrorNotice } from "../onboarding-card.js";
import { PlaceList } from "./place-list.js";
import { PlaceSignInCard } from "./place-account.js";

/**
 * The places half of the sidebar's place menu: every place this app can open,
 * checked while the menu is open, the sign-in that brings the rest, and the
 * way to add one more. Choosing a place closes the menu; everything else
 * keeps it open, because the answer appears right here.
 */
export function PlaceMenuPlaces({
  onClose,
  places,
}: {
  readonly onClose: () => void;
  readonly places: DesktopPlaces;
}) {
  const { bridge, cloudDeploymentIds, onAddPlace, snapshot } = places;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePlaceChecks(bridge, true);
  const rows = placeRows(snapshot, { cloudDeploymentIds, thisComputer: thisComputerLabel() });
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
          label="Your computers and servers"
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
