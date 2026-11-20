import {
  HomeAccountLinkClient,
  homeAccountLinkView,
  type HomeAccountLinkSnapshot,
  type HostClient,
} from "@opensteer/client/host";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { NativeSettingsSection } from "./native-settings-page.types.js";

const noSubscribe = () => () => undefined;
const emptySnapshot: HomeAccountLinkSnapshot = {
  status: null,
  error: null,
  actionError: null,
  working: false,
};
const noSnapshot = () => emptySnapshot;

/**
 * A Home on its own server's Opensteer Account link, read and changed on its
 * own: such a Home has no Remote access. Null anywhere else.
 */
export function useHomeAccountLink(host: HostClient | null, networked: boolean) {
  const client = useMemo(
    () => (networked && host ? new HomeAccountLinkClient(host) : null),
    [host, networked],
  );
  useEffect(() => client?.start(), [client]);
  const state = useSyncExternalStore(
    client?.subscribe ?? noSubscribe,
    client?.getSnapshot ?? noSnapshot,
    client?.getSnapshot ?? noSnapshot,
  );
  return client ? { client, state } : null;
}

/** The card's rows; `confirm` asks before an unlink signs Account devices out. */
export function homeAccountLinkSections(
  state: HomeAccountLinkSnapshot,
  act: {
    readonly link: () => void;
    readonly unlink: () => void;
    readonly confirm: (question: string, proceed: () => void) => void;
  },
): NativeSettingsSection[] {
  const view = homeAccountLinkView(state);
  const action = view.action;
  const linked = state.status?.accountLink?.state === "active";
  return [
    {
      key: "home-account-link",
      title: "Opensteer account",
      rows: [
        {
          key: "status",
          kind: "status",
          tone: linked ? "good" : "neutral",
          label: view.title,
          detail: view.sentence,
        },
        ...(action
          ? [
              {
                key: action.id,
                kind: "button" as const,
                label: state.working ? "Working…" : action.label,
                disabled: state.working,
                destructive: action.id === "unlink",
                onPress: () => {
                  if (action.id === "link") act.link();
                  else if (action.confirm) act.confirm(action.confirm, act.unlink);
                  else act.unlink();
                },
              },
            ]
          : []),
      ],
      ...(state.actionError
        ? { footer: { text: state.actionError, tone: "danger" as const } }
        : {}),
    },
  ];
}
