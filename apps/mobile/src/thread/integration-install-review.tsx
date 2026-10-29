import {
  integrationInstallNextStep,
  integrationInstallReview,
} from "@opensteer/client/integrations";
import type { ReactNode } from "react";
import { AppText, Notice } from "../ui/primitives.js";

/**
 * What a Request would install, in the words the web's review uses, and the
 * one note on what installing leads to.
 */
export function InstallReview(props: {
  readonly canInstall: boolean;
  /** Whether the Request goes on to an account and its access once installed. */
  readonly continuesToAccess: boolean;
  /** The title of the installation this exact manifest already produced. */
  readonly installedTitle: string | null;
  readonly manifest: unknown;
}): ReactNode {
  const review = integrationInstallReview(props.manifest);
  if (review === null) {
    return (
      <Notice
        detail="Decline this request and ask for a fresh proposal."
        title="Opensteer cannot read this installation"
        tone="danger"
      />
    );
  }
  return (
    <>
      <AppText role="body">{review.name}</AppText>
      {review.provenance === null ? null : (
        <AppText role="secondary" tone="muted">
          {review.provenance}
        </AppText>
      )}
      {review.facts.map((fact) => (
        <AppText key={fact} role="secondary" tone="muted">
          {fact}
        </AppText>
      ))}
      <Notice
        detail={integrationInstallNextStep({
          canInstall: props.canInstall,
          continuesToAccess: props.continuesToAccess,
          installedTitle: props.installedTitle,
        })}
        title={
          !props.continuesToAccess
            ? "No access yet"
            : props.installedTitle === null
              ? "Installation required"
              : "Ready to continue"
        }
        tone="neutral"
      />
    </>
  );
}
