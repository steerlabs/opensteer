import { useState } from "react";
import {
  chromeConnectPageUrl,
  readChromeConnectLink,
  type ChromeConnectLink,
} from "@opensteer/client/host";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { useChromeConnectEnvironment } from "./chrome-environment.js";
import { ConnectChrome } from "./connect-chrome.js";

/**
 * `/connect/chrome`: where the Opensteer app, another browser or a copied link
 * sends Chrome. It needs no sign-in — the link carries a one-use code only the
 * extension can redeem — so it renders before anything about a session loads.
 */
export function ChromeConnectPage({ fragment }: { readonly fragment: string }) {
  const [link] = useState((): ChromeConnectLinkState => {
    try {
      return { error: null, link: readChromeConnectLink(fragment, window.location.origin) };
    } catch (reason) {
      return {
        error:
          reason instanceof Error
            ? reason.message
            : "This link doesn’t work. Go back to Opensteer and choose Connect Chrome again.",
        link: null,
      };
    }
  });
  return <ChromeConnectCard state={link} />;
}

export type ChromeConnectLinkState =
  | { readonly error: null; readonly link: ChromeConnectLink }
  | { readonly error: string; readonly link: null };

export function ChromeConnectCard({ state }: { readonly state: ChromeConnectLinkState }) {
  const environment = useChromeConnectEnvironment({ desktopBridge: null, hostHere: null });
  const [copied, setCopied] = useState<boolean | null>(null);

  if (!state.link) {
    return (
      <OnboardingCard
        description="Connection links work once and expire after 15 minutes."
        eyebrow="Opensteer"
        title="Connect Chrome"
        titleId="chrome-connect-title"
      >
        <ErrorNotice message={state.error} />
      </OnboardingCard>
    );
  }

  const { deploymentName, invitation } = state.link;
  const otherBrowser = environment.place !== "chromium";
  return (
    <OnboardingCard
      description={`Lets agents in ${deploymentName} use websites you’re signed in to in this Chrome. You approve each site once.`}
      eyebrow="Opensteer"
      title={`Connect Chrome to ${deploymentName}`}
      titleId="chrome-connect-title"
    >
      <div className="chrome-connect-page">
        <ConnectChrome client={null} environment={environment} invitation={invitation} />
        {otherBrowser && environment.place !== "phone" ? (
          <div className="chrome-connect-page__copy">
            <button
              className="btn onboarding__primary"
              onClick={() =>
                void environment
                  .copy(chromeConnectPageUrl(window.location.origin, invitation))
                  .then(setCopied)
              }
              type="button"
            >
              Copy this page’s address
            </button>
            <p aria-live="polite" className="connect-chrome__hint">
              {copied === true
                ? "Copied. Paste it into Chrome’s address bar."
                : copied === false
                  ? "Couldn’t copy. Go back to Opensteer and choose Connect Chrome from Chrome."
                  : "The address works once, for 15 minutes."}
            </p>
          </div>
        ) : null}
      </div>
    </OnboardingCard>
  );
}
