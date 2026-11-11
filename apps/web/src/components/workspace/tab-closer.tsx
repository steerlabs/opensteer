import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  reviewHostAction,
  HostClientRequestError,
  type BrowserTabCatalog,
  type BrowserTabCloseImpact,
  type HostClient,
  type PlaceItem,
} from "@opensteer/client/host";
import { staleBrowserTabInventoryReason } from "@opensteer/protocol";
import { useActionReview } from "@opensteer/client/react";
import { actionErrorMessage } from "../../ui-utils.js";
import { Dialog } from "../dialog.js";
import { useToast } from "../toast.js";

/**
 * Closing a tab is one Host operation at the catalog revision the reader saw;
 * a stale revision is refused rather than guessed at. Closing under live work
 * asks first. Nothing here changes what the middle shows: when the tab there
 * leaves the list, its successor takes it ([place succession](./place-succession.ts)).
 */
const TabCloserContext = createContext<((place: PlaceItem) => void) | null>(null);

type Expected = Pick<BrowserTabCatalog, "generation" | "revision" | "inventoryRevision">;

/**
 * A close's expected inventory and what it takes with it, from the tab's
 * group as the client holds it: its sleeping tabs count, since they stay.
 */
function closeTarget(
  hostClient: HostClient,
  sessionId: string,
  tabId: string,
): { readonly expected: Expected; readonly impact: BrowserTabCloseImpact } | null {
  const store = hostClient.browserTabs;
  const groupId = store.groupForSession(sessionId);
  const group = groupId ? store.group(groupId) : undefined;
  const expected = store.inventory(sessionId);
  if (!groupId || !group || !expected || !store.tab(groupId, tabId)) return null;
  return {
    expected,
    impact: {
      heldByLiveWork: group.attachedRunIds.length > 0,
      discardsFreshSignIns: store.tabs(groupId).ids.length === 1 && group.profileId === null,
    },
  };
}
const TabGroupCloserContext = createContext<((tabIds: readonly string[]) => void) | null>(null);
export function useTabGroupCloser() {
  const close = useContext(TabGroupCloserContext);
  if (!close) throw new Error("Closing tab groups is not available here.");
  return close;
}
const TabCloseAskingContext = createContext(false);

export function useTabCloser(): (place: PlaceItem) => void {
  const close = useContext(TabCloserContext);
  if (!close) throw new Error("Closing tabs is not available here.");
  return close;
}

/** A close is waiting for the person's answer: the page behind the question takes no input. */
export function useTabCloseAsking(): boolean {
  return useContext(TabCloseAskingContext);
}

export function TabCloserProvider({
  children,
  hostClient,
}: {
  readonly children: ReactNode;
  readonly hostClient: HostClient;
}) {
  const toast = useToast();
  const { review, ask, dismiss: dismissReview } = useActionReview(hostClient);
  const [confirming, setConfirming] = useState<{
    readonly impact: BrowserTabCloseImpact;
    readonly opener: HTMLElement | null;
  } | null>(null);
  const close = useCallback(
    async (place: PlaceItem, expected: Expected, opener: HTMLElement | null) => {
      if (place.destination.kind !== "browser" || !place.destination.tabId) return;
      const { sessionId, tabId } = place.destination;
      try {
        await hostClient.closeBrowserTab(sessionId, tabId, {
          generation: expected.generation,
          revision: expected.revision,
          inventoryRevision: expected.inventoryRevision ?? expected.revision,
        });
      } catch (error) {
        if (
          error instanceof HostClientRequestError &&
          error.reason === staleBrowserTabInventoryReason
        ) {
          try {
            await hostClient.readWorkspaceTabs?.(sessionId);
            const target = closeTarget(hostClient, sessionId, tabId);
            if (target) {
              ask({ kind: "close-tab", sessionId, tabId }, () =>
                close(place, target.expected, opener),
              );
              setConfirming({ opener, impact: target.impact });
            }
          } catch (readError) {
            toast.error(actionErrorMessage(readError));
          }
        } else toast.error(actionErrorMessage(error));
      }
    },
    [ask, hostClient, toast],
  );
  const request = useCallback(
    (place: PlaceItem) => {
      if (place.destination.kind === "phone" && place.phoneTab && place.closable) {
        void hostClient
          .closePhoneTab(place.destination.machineId)
          .catch((error: unknown) => toast.error(actionErrorMessage(error)));
        return;
      }
      // The person's own view of an app or phone: × ends that view for them,
      // in every window; the app and any task in it carry on.
      if (place.ownerClose) {
        const { generation, viewId } = place.ownerClose;
        void reviewHostAction(hostClient, { kind: "close-view", viewId, generation })
          ?.confirm()
          .catch((error: unknown) => toast.error(actionErrorMessage(error)));
        return;
      }
      if (place.destination.kind === "opensteer-app") {
        void hostClient
          .closeAppTab(place.destination.appId)
          .catch((error: unknown) => toast.error(actionErrorMessage(error)));
        return;
      }
      if (!place.closable || place.destination.kind !== "browser") return;
      const { sessionId, tabId } = place.destination;
      const target = tabId ? closeTarget(hostClient, sessionId, tabId) : null;
      if (!tabId || !target) return;
      if (target.impact.heldByLiveWork) {
        const opener =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        ask({ kind: "close-tab", sessionId, tabId }, () => close(place, target.expected, opener));
        setConfirming({ impact: target.impact, opener });
      } else void close(place, target.expected, null);
    },
    [ask, close, hostClient, toast],
  );
  const [confirmingGroup, setConfirmingGroup] = useState<readonly string[] | null>(null);
  const closeGroup = useCallback(
    (tabIds: readonly string[]) => {
      void hostClient
        .closeWorkspaceTabs(tabIds)
        .then((result) => {
          if (result.failed.length)
            toast.error(result.failed.map((failure) => failure.message).join("\n"));
        })
        .catch((error: unknown) => toast.error(actionErrorMessage(error)));
    },
    [hostClient, toast],
  );
  const requestGroup = useCallback(
    (tabIds: readonly string[]) => {
      const ids = [...tabIds];
      const store = hostClient.browserTabs;
      const held = ids.some((id) => {
        const groupId = store.groupForTab(id);
        const group = groupId ? store.group(groupId) : undefined;
        return group !== undefined && group.attachedRunIds.length > 0;
      });
      if (held) setConfirmingGroup(ids);
      else closeGroup(ids);
    },
    [closeGroup, hostClient],
  );
  const value = useMemo(() => request, [request]);
  const dismiss = () => {
    const opener = confirming?.opener;
    dismissReview();
    setConfirming(null);
    if (opener?.isConnected) opener.focus();
  };
  useEffect(() => {
    if (confirming && !review) {
      setConfirming(null);
      if (confirming.opener?.isConnected) confirming.opener.focus();
    }
  }, [confirming, review]);
  return (
    <TabCloserContext.Provider value={value}>
      <TabGroupCloserContext.Provider value={requestGroup}>
        <TabCloseAskingContext.Provider value={confirming !== null || confirmingGroup !== null}>
          {children}
        </TabCloseAskingContext.Provider>
      </TabGroupCloserContext.Provider>
      {confirmingGroup ? (
        <Dialog
          footer={
            <>
              <button className="btn" onClick={() => setConfirmingGroup(null)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  closeGroup(confirmingGroup);
                  setConfirmingGroup(null);
                }}
                type="button"
              >
                Close group
              </button>
            </>
          }
          labelledBy="tab-group-close-title"
          onClose={() => setConfirmingGroup(null)}
          title="Close this group?"
        >
          <p className="browser-dialog__message">
            An agent is working here. These tabs close for you and for the agent.
          </p>
        </Dialog>
      ) : null}
      {confirming && review ? (
        <Dialog
          footer={
            <>
              <button className="btn" onClick={dismiss} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  const result = review.confirm();
                  dismiss();
                  void result.catch((error: unknown) => toast.error(actionErrorMessage(error)));
                }}
                type="button"
              >
                Close tab
              </button>
            </>
          }
          labelledBy="tab-close-title"
          onClose={dismiss}
          title="Close this tab?"
        >
          <p className="browser-dialog__message">
            An agent is working here. This tab closes for you and for the agent.
            {confirming.impact.discardsFreshSignIns
              ? " Its sign-ins are discarded; other saved tabs stay."
              : ""}
          </p>
        </Dialog>
      ) : null}
    </TabCloserContext.Provider>
  );
}
