import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  HomeAccountLinkClient,
  homeAccountLinkView,
  linkPersonalHostAccount,
  type HomeAccountLinkCourier,
  type HomeAccountLinkSnapshot,
} from "@opensteer/client/host";
import { useShell } from "../../app-shell.js";
import { linkAccountThroughPortal } from "../link-personal-account.js";
import { SettingsError, SettingsGroup, SettingsRow } from "../primitives.js";

/**
 * The Opensteer Account link of a Home on its own server. That Home has no
 * Remote access, so its link is shown and changed here on its own.
 */
export function HomeAccountLinkCard() {
  const { desktopBridge, hostClient, snapshot } = useShell();
  const networked = snapshot.identityConfig?.exposure === "networked";
  const client = useMemo(
    () => (networked && hostClient ? new HomeAccountLinkClient(hostClient) : null),
    [hostClient, networked],
  );
  useEffect(() => client?.start(), [client]);
  const state = useSyncExternalStore(
    client?.subscribe ?? noSubscribe,
    client?.getSnapshot ?? noSnapshot,
    client?.getSnapshot ?? noSnapshot,
  );
  if (!client || !hostClient) return null;
  const name = snapshot.identityConfig?.deployment.name ?? "Opensteer";
  const issue = desktopBridge?.issuePersonalAccountLinkChallenge;
  const complete = desktopBridge?.completePersonalAccountLink;
  // The app signs in to the Account itself; a browser links in the Account's own page.
  const courier: HomeAccountLinkCourier =
    desktopBridge && issue && complete
      ? (authorityEnvelope) =>
          linkPersonalHostAccount(
            hostClient,
            {
              issuePersonalHostAccountLinkChallenge: (request) =>
                issue.call(desktopBridge, request),
              completePersonalHostAccountLink: (_challengeId, request) =>
                complete.call(desktopBridge, request),
            },
            authorityEnvelope,
            name,
          )
      : (authorityEnvelope) =>
          linkAccountThroughPortal({
            authorityEnvelope,
            hostClient,
            name,
            portalOrigin: snapshot.identityConfig?.portalOrigin ?? null,
          });
  return (
    <HomeAccountLinkCardView
      onLink={() => void client.link(courier)}
      onUnlink={() => void client.unlink()}
      state={state}
    />
  );
}

export function HomeAccountLinkCardView({
  onLink,
  onUnlink,
  state,
}: {
  readonly onLink: () => void;
  readonly onUnlink: () => void;
  readonly state: HomeAccountLinkSnapshot;
}) {
  const view = homeAccountLinkView(state);
  const action = view.action;
  return (
    <SettingsGroup heading="Opensteer account" headingId="settings-home-account-link">
      <SettingsRow
        title={view.title}
        detail={view.sentence}
        action={
          action ? (
            <button
              className={action.id === "unlink" ? "settings-link settings-link--danger" : "btn"}
              disabled={state.working}
              onClick={() => {
                if (action.confirm && !window.confirm(action.confirm)) return;
                if (action.id === "link") onLink();
                else onUnlink();
              }}
              type="button"
            >
              {state.working ? "Working…" : action.label}
            </button>
          ) : null
        }
      />
      <SettingsError message={state.actionError} />
    </SettingsGroup>
  );
}

const noSubscribe = () => () => undefined;
const emptySnapshot: HomeAccountLinkSnapshot = {
  status: null,
  error: null,
  actionError: null,
  working: false,
};
const noSnapshot = () => emptySnapshot;
