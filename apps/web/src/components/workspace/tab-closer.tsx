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
  browserTabCloseImpact,
  reviewHostAction,
  HostClientRequestError,
  unwrapRpcResult,
  type BrowserTabCloseImpact,
  type HostClient,
  type PlaceItem,
} from "@opensteer/client/host";
import { staleBrowserTabInventoryReason, type BrowserTabCatalog } from "@opensteer/protocol";
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
    async (place: PlaceItem, expected: BrowserTabCatalog, opener: HTMLElement | null) => {
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
            const catalog = unwrapRpcResult(
              await hostClient.rpc["browser.tabs.get"]({ sessionId }),
            );
            const session = hostClient
              .getSnapshot()
              .browserSessions.find((candidate) => candidate.id === sessionId);
            if (session && catalog.tabs.some((tab) => tab.id === tabId)) {
              ask({ kind: "close-tab", sessionId, tabId }, () => close(place, catalog, opener));
              setConfirming({
                opener,
                impact: browserTabCloseImpact({ ...session, tabCatalog: catalog }),
              });
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
      // The person's own view of an app or phone: × ends that view for them,
      // in every window; the app and any task in it carry on.
      if (place.ownerClose) {
        const { generation, viewId } = place.ownerClose;
        void reviewHostAction(hostClient, { kind: "close-view", viewId, generation })
          ?.confirm()
          .catch((error: unknown) => toast.error(actionErrorMessage(error)));
        return;
      }
      if (!place.closable || place.destination.kind !== "browser") return;
      const sessionId = place.destination.sessionId;
      const group = hostClient
        .getSnapshot()
        .workspaceTabs?.find((group) => group.id === place.workspaceTab?.lineageId);
      if (
        group &&
        !hostClient.getSnapshot().browserSessions.find((session) => session.id === sessionId)
          ?.tabCatalog
      ) {
        const tabId = place.destination.tabId;
        if (tabId)
          void hostClient
            .closeBrowserTab(sessionId, tabId, { generation: 0, revision: group.revision })
            .catch((error: unknown) => toast.error(actionErrorMessage(error)));
        return;
      }
      const session = hostClient
        .getSnapshot()
        .browserSessions.find((candidate) => candidate.id === sessionId);
      if (!session?.tabCatalog) return;
      const impact = browserTabCloseImpact(session);
      if (impact.heldByLiveWork) {
        const opener =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const tabId = place.destination.tabId;
        if (!tabId) return;
        const expected = session.tabCatalog;
        ask({ kind: "close-tab", sessionId, tabId }, () => close(place, expected, opener));
        setConfirming({ impact, opener });
      } else void close(place, session.tabCatalog, null);
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
      const held = hostClient
        .getSnapshot()
        .browserSessions.some(
          (session) =>
            session.tabCatalog?.tabs.some((tab) => ids.includes(tab.id)) &&
            browserTabCloseImpact(session).heldByLiveWork,
        );
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
