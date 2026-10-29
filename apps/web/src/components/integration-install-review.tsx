import { integrationInstallReview } from "@opensteer/client/integrations";
import { ActionNote } from "./action-rows.js";

/**
 * What a Request would install, as a person decides on it. Approving an
 * installation is not approving access, so what comes next is the one note
 * its caller places beneath it.
 */
export function IntegrationInstallReview({ manifest }: { readonly manifest: unknown }) {
  const review = integrationInstallReview(manifest);
  if (!review) {
    return (
      <ActionNote alert>
        Opensteer cannot read what this request would install. Decline it and ask for a fresh
        proposal.
      </ActionNote>
    );
  }
  return (
    <div className="action-field">
      <span className="action-field__title">{review.name}</span>
      {review.provenance ? <span>{review.provenance}</span> : null}
      {review.facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
