import { useAppView } from "@opensteer/client/react";
import type { AppEntry, HostClient } from "@opensteer/client/host";
import { AppIdSchema, type TabId } from "@opensteer/core";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { actionErrorMessage } from "../../ui-utils.js";
import { TranscriptHostClientContext } from "../attachments/message-attachments.js";
import { Icon } from "../icon.js";
import { useToast } from "../toast.js";
import { destinationPlaceKey } from "../workspace/navigation.js";
import { useOptionalWorkspace, type WorkspaceState } from "../workspace/workspace-context.js";
import { AppFrame, AppLoadFailure, AppLoading, useAppTheme } from "./app-frame.js";

const noSubscription = () => () => undefined;

/** While open as a tab it is a row that goes there, so a client never runs two copies. */
export function AppCard({ entry }: { readonly entry: AppEntry }) {
  const client = useContext(TranscriptHostClientContext);
  const workspace = useOptionalWorkspace();
  const card = useRef<HTMLElement | null>(null);
  const { appId } = entry;
  // The app's one tab, while the person's list has it: then this card is a way there.
  const appTab = useSyncExternalStore(
    client?.subscribe ?? noSubscription,
    () => {
      if (!client) return null;
      for (const tab of client.getSnapshot().tabs.rows.values())
        if (tab.kind === "app" && tab.appId === appId) return tab;
      return null;
    },
  );
  // The pressed control is replaced; the keyboard stays in this card.
  const keepFocus = () =>
    requestAnimationFrame(() =>
      card.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
    );
  const tab = client && workspace && appTab !== null;
  return (
    <section className={tab ? "app-card app-card--tab" : "app-card"} ref={card}>
      {tab ? (
        <AppTabRow
          client={client}
          onClosed={keepFocus}
          tabId={appTab.tabId}
          title={appTab.title}
          workspace={workspace}
        />
      ) : (
        <LiveApp
          card={card}
          client={client}
          entry={entry}
          onOpened={keepFocus}
          workspace={workspace}
        />
      )}
    </section>
  );
}

function AppTabRow({
  client,
  onClosed,
  tabId,
  title,
  workspace,
}: {
  readonly tabId: TabId;
  readonly client: HostClient;
  readonly onClosed: () => void;
  readonly title: string;
  readonly workspace: WorkspaceState;
}) {
  const toast = useToast();
  const { nav, selection } = workspace;
  const destination = { kind: "tab", tabId } as const;
  const showing =
    selection.kind === "place" &&
    destinationPlaceKey(selection.destination) === destinationPlaceKey(destination);
  return (
    <>
      <button
        className="app-card__go"
        disabled={showing}
        onClick={() => nav.showPlace(destination)}
        type="button"
      >
        <span aria-hidden className="app-card__mark">
          <Icon name="app" />
        </span>
        <span className="app-card__words">
          <span className="app-card__title">{title}</span>
          <span className="app-card__where">
            {showing ? "Showing in its tab" : "Open in a tab"}
          </span>
        </span>
        {showing ? null : <Icon className="app-card__arrow" name="arrow-right" />}
      </button>
      <button
        aria-label={`Close the ${title} tab`}
        className="icon-btn"
        onClick={() => {
          void client
            .closeTabs([tabId])
            .catch((error: unknown) => toast.error(actionErrorMessage(error)));
          onClosed();
        }}
        title="Close tab"
        type="button"
      >
        <Icon name="close" />
      </button>
    </>
  );
}

function LiveApp({
  card,
  client,
  entry,
  onOpened,
  workspace,
}: {
  readonly card: RefObject<HTMLElement | null>;
  readonly client: HostClient | null;
  readonly entry: AppEntry;
  readonly onOpened: () => void;
  readonly workspace: WorkspaceState | null;
}) {
  const toast = useToast();
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const theme = useAppTheme();
  useEffect(() => {
    if (near || !card.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [card, near]);
  const { view, failed, retry } = useAppView(client, entry.appId, theme, near);
  const title = view?.app.title ?? entry.title;
  return (
    <>
      <header className="app-card__header">
        <span>{title}</span>
        {client && workspace ? (
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              const show = workspace.nav.beginPlaceOperation();
              void client
                .openTab({ kind: "app", appId: AppIdSchema.parse(entry.appId) })
                .then((tab) => {
                  show({ kind: "tab", tabId: tab.tabId });
                  onOpened();
                })
                .catch((error: unknown) => toast.error(actionErrorMessage(error)));
            }}
          >
            Open
          </button>
        ) : null}
      </header>
      {failed ? (
        <AppLoadFailure retry={retry} />
      ) : view ? (
        <AppFrame key={view.url} url={view.url} title={title} theme={theme} retry={retry} />
      ) : client ? (
        <AppLoading />
      ) : (
        <p role="status">App unavailable</p>
      )}
    </>
  );
}
