import { useMemo, useState } from "react";
import { useRemoteDesktopUpdate } from "@opensteer/client/react";
import type { DesktopUpdateAction } from "@opensteer/client/settings";
import { DeploymentIdSchema } from "@opensteer/core";
import { BridgeDesktopUpdates } from "../../desktop/deployment-updates.js";
import type { PlaceRow } from "../../desktop/places.js";
import { useDesktopPlaces } from "../../desktop/places-context.js";

/** The way out of "Needs update": this app can't open that computer, but can update it. */
export function PlaceUpdate({ row }: { readonly row: PlaceRow }) {
  const places = useDesktopPlaces();
  const bridge = places?.bridge.deploymentUpdates ?? null;
  const updates = useMemo(
    () =>
      bridge === null ? null : new BridgeDesktopUpdates(bridge, DeploymentIdSchema.parse(row.id)),
    [bridge, row.id],
  );
  const { run, view } = useRemoteDesktopUpdate(updates, row.name, updates !== null);
  const [confirming, setConfirming] = useState<Extract<
    DesktopUpdateAction,
    { readonly kind: "request" }
  > | null>(null);
  if (updates === null || view.hidden) return null;
  if (confirming)
    return (
      <>
        <p>{confirming.confirm.body}</p>
        <div className="place-row__actions">
          <button
            className="btn btn--small btn--primary"
            onClick={() => {
              setConfirming(null);
              run(confirming);
            }}
            type="button"
          >
            {confirming.confirm.confirmLabel}
          </button>
          <button
            className="btn btn--small btn--ghost"
            onClick={() => setConfirming(null)}
            type="button"
          >
            Cancel
          </button>
        </div>
      </>
    );
  const action = view.action;
  return (
    <>
      <p role="status">
        {[view.headline, view.statusLine, view.result?.text].filter(Boolean).join(" · ")}
      </p>
      {action ? (
        <div className="place-row__actions">
          <button
            className="btn btn--small"
            onClick={() => (action.kind === "request" ? setConfirming(action) : run(action))}
            type="button"
          >
            {action.label}
          </button>
        </div>
      ) : null}
    </>
  );
}
