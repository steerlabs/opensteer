import type { BrowserCommand, HostClient, PlaceItem } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { actionErrorMessage } from "../../ui-utils.js";
import { Popover } from "../popover.js";
import { SurfaceMenuRow, type SurfaceMenuItem } from "../surface-menu.js";
import { SurfaceSubmenuRow } from "../surface-submenu-row.js";
import { useToast } from "../toast.js";
import { ProfileAvatar, browserWords, type BrowserPresentation } from "./identity.js";
import { OpenInRow } from "./open-in.js";
import { useTabCloser } from "./tab-closer.js";
import { tabGroupStyle } from "./tab-group.js";
import { useWorkspace, type LocalMachine } from "./workspace-context.js";

/**
 * A web tab's own menu, as a browser's tab has, under a line naming its
 * profile: Reload, Duplicate tab, Open this page in…, Copy link, Close tab.
 * The full address comes from the tab's candidate read; the catalog only knows
 * its site. Nothing here moves the middle except what opens a page, which shows
 * it as a browser does.
 */
export function TabMenu({
  anchor,
  at,
  hostClient,
  onClose,
  onEditGroup,
  place,
  presentation,
}: {
  /** The row's main control: focus comes back to it, and stays on the row an action keeps. */
  readonly anchor: HTMLElement;
  readonly at: { readonly x: number; readonly y: number };
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly onEditGroup: (id: string | null) => void;
  readonly place: PlaceItem;
  readonly presentation: BrowserPresentation | null;
}) {
  const { nav } = useWorkspace();
  const layout = useHostSelector(hostClient, (snapshot) => snapshot.browserTabGroups);
  const reopenAvailable = useHostSelector(
    hostClient,
    (snapshot) => snapshot.workspaceTabReopenAvailable,
  );
  const toast = useToast();
  const requestClose = useTabCloser();
  if (place.destination.kind !== "browser" || !place.destination.tabId) return null;
  const { sessionId, tabId } = place.destination;
  const surfaceId = BrowserSurfaceIdSchema.parse(tabId);
  const currentGroup = layout?.groups.find((group) => group.tabIds.includes(surfaceId));
  const otherGroups = layout?.groups.filter((group) => group.id !== currentGroup?.id) ?? [];
  const failed = (error: unknown) => toast.error(actionErrorMessage(error));
  const address = () =>
    hostClient.readBrowserContextCandidate(sessionId, tabId).then((candidate) => candidate.url);
  // The clipboard exists only in a secure context; a Host over plain HTTP has no Copy link.
  const clipboard = globalThis.navigator?.clipboard;
  const ready = place.availability === "ready";
  const opening: readonly SurfaceMenuItem[] = [
    {
      disabled: !ready,
      icon: "reload",
      label: "Reload",
      onSelect: () =>
        void sendToTab(hostClient, sessionId, tabId, {
          surfaceId,
          type: "navigation.reload",
        }).catch(() => toast.error("The tab didn’t reload. Try again.")),
    },
    {
      disabled: !ready,
      icon: "browser",
      label: "Duplicate tab",
      onSelect: () => {
        const show = nav.beginPlaceOperation();
        void address()
          .then((url) =>
            hostClient.openBrowserTab(sessionId, /^https?:\/\//iu.test(url) ? { url } : {}),
          )
          .then((opened) => show({ kind: "browser", sessionId, tabId: opened.tabId }), failed);
      },
    },
  ];
  const copying: readonly SurfaceMenuItem[] = clipboard
    ? [
        {
          disabled: !ready,
          icon: "copy",
          label: "Copy link",
          onSelect: () =>
            void address()
              .then((url) => clipboard.writeText(url))
              .then(() => toast.success("Link copied"), failed),
        },
      ]
    : [];
  const reopen: SurfaceMenuItem = {
    icon: "reload",
    label: "Reopen closed tab",
    onSelect: () => {
      const show = nav.beginPlaceOperation();
      void hostClient.reopenWorkspaceTab?.().then(
        (result) =>
          show({
            kind: "browser",
            sessionId: result.group.session.id,
            tabId: result.tabId,
          }),
        failed,
      );
    },
  };
  const closing: SurfaceMenuItem = {
    icon: "close",
    label: "Close tab",
    onSelect: () => requestClose(place),
  };
  const choose = (item: SurfaceMenuItem) => () => {
    onClose();
    // The row keeps the keyboard; if the action takes the row away, its rescue
    // hands focus to the neighbouring row.
    anchor.focus();
    item.onSelect?.();
  };
  const words = presentation ? browserWords(presentation) : null;
  return (
    <Popover
      anchor={anchor}
      at={at}
      className="popover--surface popover--tab-menu"
      label={words ? `${place.title} — ${words}` : place.title}
      onClose={onClose}
    >
      {presentation && words ? (
        <div aria-hidden className="tab-menu__identity">
          <ProfileAvatar identity={presentation.identity} size={14} />
          <span>{words}</span>
        </div>
      ) : null}
      <div className="picker__section">
        {opening.map((item) => (
          <SurfaceMenuRow item={item} key={item.label} onChoose={choose(item)} />
        ))}
        <OpenInRow
          disabled={!ready}
          hostClient={hostClient}
          onDone={() => {
            onClose();
            anchor.focus();
          }}
          place={place}
          presentation={presentation}
        />
        {copying.map((item) => (
          <SurfaceMenuRow item={item} key={item.label} onChoose={choose(item)} />
        ))}
      </div>
      {layout && place.workspaceTab ? (
        <div className="picker__section">
          <SurfaceSubmenuRow icon="plus" label="Add to group">
            <div className="picker__section">
              <SurfaceMenuRow
                item={{ icon: "plus", label: "New group" }}
                onChoose={() => {
                  onClose();
                  void hostClient.groupBrowserTabs([tabId], {}).then(onEditGroup, failed);
                }}
              />
            </div>
            {otherGroups.length > 0 ? (
              <div className="picker__section">
                {otherGroups.map((group) => (
                  <button
                    className="picker__row"
                    key={group.id}
                    onClick={() => {
                      onClose();
                      void hostClient
                        .groupBrowserTabs([tabId], { groupId: group.id })
                        .catch(failed);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span className="picker__check">
                      <span className="tab-group-dot" style={tabGroupStyle(group.color)} />
                    </span>
                    <span className="picker__label">{group.title || "Untitled"}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </SurfaceSubmenuRow>
          {currentGroup ? (
            <SurfaceMenuRow
              item={{ icon: "browser", label: "Remove from group" }}
              onChoose={() => {
                onClose();
                void hostClient.ungroupBrowserTabs([tabId]).catch(failed);
              }}
            />
          ) : null}
        </div>
      ) : null}
      <div className="picker__section">
        <SurfaceMenuRow item={closing} onChoose={choose(closing)} />
        {reopenAvailable && hostClient.reopenWorkspaceTab ? (
          <SurfaceMenuRow item={reopen} onChoose={choose(reopen)} />
        ) : null}
      </div>
    </Popover>
  );
}

/** Whether an app's or phone's row has anything to offer in a menu of its own. */
export function nativeTabMenuOffered(place: PlaceItem, local: LocalMachine | null): boolean {
  return (
    place.ownerClose !== null ||
    (place.kind === "app" &&
      place.ownerView !== null &&
      local?.useApp != null &&
      local.machineId === place.device?.machineId)
  );
}

/**
 * An app's or phone's own menu: bring the app forward on this Mac (only the
 * desktop app, only for this Mac), or close the person's view — which never
 * quits the app and never stops a task.
 */
export function NativeTabMenu({
  anchor,
  at,
  onClose,
  place,
}: {
  readonly anchor: HTMLElement;
  readonly at: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
  readonly place: PlaceItem;
}) {
  const { localMachine } = useWorkspace();
  const toast = useToast();
  const requestClose = useTabCloser();
  const view = place.ownerView;
  const app = place.icon.kind === "app" ? place.icon.app : null;
  const useHere =
    place.kind === "app" &&
    view !== null &&
    app !== null &&
    localMachine?.useApp != null &&
    localMachine.machineId === place.device?.machineId
      ? localMachine.useApp
      : null;
  const items: SurfaceMenuItem[] = [
    ...(useHere && view && app
      ? [
          {
            icon: "external-link" as const,
            label: "Use on this Mac",
            onSelect: () =>
              void useHere({ viewId: view.viewId, generation: view.generation }, app).catch(
                (error: unknown) => toast.error(actionErrorMessage(error)),
              ),
          },
        ]
      : []),
    ...(place.ownerClose
      ? [
          {
            detail:
              place.occupants.length > 0 ? "The task keeps working" : `${place.title} stays open`,
            icon: "close" as const,
            label: "Close view",
            onSelect: () => requestClose(place),
          },
        ]
      : []),
  ];
  return (
    <Popover
      anchor={anchor}
      at={at}
      className="popover--surface popover--tab-menu"
      label={place.title}
      onClose={onClose}
    >
      <div className="picker__section">
        {items.map((item) => (
          <SurfaceMenuRow
            item={item}
            key={item.label}
            onChoose={() => {
              onClose();
              anchor.focus();
              item.onSelect?.();
            }}
          />
        ))}
      </div>
    </Popover>
  );
}

/**
 * A page command for one exact tab, whether or not it is the one in the
 * middle: sent at once where that tab already has a viewer, else through the
 * tab's own targeted control, held just long enough to deliver it.
 */
export function sendToTab(
  hostClient: HostClient,
  sessionId: string,
  tabId: string,
  command: BrowserCommand,
): Promise<void> {
  let refusal: unknown = null;
  const attempt = () => {
    try {
      hostClient.sendBrowserCommand(sessionId, command);
      return true;
    } catch (error) {
      refusal = error;
      return false;
    }
  };
  if (attempt()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let release: (() => void) | null = null;
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (sent: boolean) => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      // The socket sends what it was given before it closes; the hold lingers a moment anyway.
      const held = release;
      release = null;
      if (held) setTimeout(held, 1_000);
      if (sent) resolve();
      else reject(refusal instanceof Error ? refusal : new Error("The tab is unavailable."));
    };
    try {
      release = hostClient.retainBrowserViewer(sessionId, tabId, { captureRegion: true });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    unsubscribe = hostClient.browserFrames.subscribe(
      sessionId,
      () => {
        if (release && attempt()) finish(true);
      },
      tabId,
    );
    timer = setTimeout(() => finish(false), 8_000);
    if (attempt()) finish(true);
  });
}
