import { copyText } from "@opensteer/shared/clipboard";
import type { BrowserCommand, HostClient, PlaceItem } from "@opensteer/client/host";
import { useHostSelector, useTabLayout } from "@opensteer/client/react";
import { deviceElsewhere } from "@opensteer/client/computers";
import {
  TabGroupColorSchema,
  type TabGroup,
  type TabGroupColor,
  type TabId,
  type TabTarget,
} from "@opensteer/core";
import type { TabOrganizeInput } from "@opensteer/protocol";
import { act, toastFailure } from "../use-action.js";
import { DeviceLabel } from "../computers/device-label.js";
import { useHereId } from "../computers/here.js";
import { Popover } from "../popover.js";
import { SurfaceMenuRow, type SurfaceMenuItem } from "../surface-menu.js";
import { SurfaceSubmenuRow } from "../surface-submenu-row.js";
import { useToast } from "../toast.js";
import { ProfileAvatar, browserWords, type BrowserPresentation } from "./identity.js";
import { OpenInRow } from "./open-in.js";
import { useTabCloser } from "./tab-closer.js";
import { tabGroupStyle } from "./tab-group.js";
import { useWorkspace } from "./workspace-context.js";

/**
 * One menu for every kind of tab: a page's own actions (Reload, Duplicate,
 * Open this page in…, Copy link) while this device views it, a window's Use on
 * this Mac, grouping, Close and Reopen. Closing only takes the tab off the list.
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
  const { nav, localMachine } = useWorkspace();
  const layout = useTabLayout(hostClient);
  const machines = useHostSelector(hostClient, (snapshot) => snapshot.machines);
  const viewer = useHostSelector(hostClient, () => hostClient.tabViewer(place.key));
  const hereId = useHereId();
  const toast = useToast();
  const requestClose = useTabCloser();
  const tabId = place.key;
  const groups = layout.items.flatMap((item) => (item.kind === "group" ? [item.group] : []));
  const currentGroup = groups.find((group) => group.tabIds.includes(tabId));
  const otherGroups = groups.filter((group) => group.groupId !== currentGroup?.groupId);
  // The menu is gone by the answer, so only a toast is left to say it didn't happen.
  const failed = toastFailure(toast);
  const ready = place.availability === "ready";
  const page = place.kind === "page" ? place.tab : null;
  const pageSession = viewer?.kind === "page" ? viewer.sessionId : null;
  const url = page?.url && /^https?:\/\//iu.test(page.url) ? page.url : null;
  // The clipboard exists only in a secure context; a Host over plain HTTP has no Copy link.
  const clipboard = globalThis.navigator?.clipboard;
  const view = viewer?.kind === "window" ? viewer.view : null;
  const useHere =
    place.kind === "window" &&
    view !== null &&
    view.target.kind === "app" &&
    localMachine?.useApp != null &&
    localMachine.machineId === place.device.machineId
      ? { use: localMachine.useApp, app: view.target.app, view }
      : null;
  const pageItems: readonly SurfaceMenuItem[] = page
    ? [
        {
          disabled: !ready || !pageSession,
          icon: "reload",
          label: "Reload",
          onSelect: () =>
            pageSession &&
            void sendToTab(hostClient, pageSession, tabId, {
              surfaceId: tabId,
              type: "navigation.reload",
            }).catch(() => toast.error("The tab didn’t reload. Try again.")),
        },
        {
          disabled: !url,
          icon: "browser",
          label: "Duplicate tab",
          onSelect: () => {
            if (!url) return;
            const show = nav.beginPlaceOperation();
            void act(hostClient, { label: "duplicate this tab", done: "duplicated" }, () =>
              hostClient.openTab(
                (page.profile
                  ? { kind: "page", url, profileId: page.profile.profileId }
                  : {
                      kind: "page",
                      url,
                      guest: true,
                      computerId: page.computer.computerId,
                    }) as TabTarget,
              ),
            ).then((opened) => show({ kind: "tab", tabId: opened.tabId }), failed);
          },
        },
      ]
    : [];
  const copying: readonly SurfaceMenuItem[] =
    clipboard && url
      ? [
          {
            icon: "copy",
            label: "Copy link",
            onSelect: () =>
              void copyText(url).then(
                (success) =>
                  success
                    ? toast.success("Link copied")
                    : toast.error("Copy was blocked. Select the link to copy it."),
                failed,
              ),
          },
        ]
      : [];
  const nativeItems: readonly SurfaceMenuItem[] = useHere
    ? [
        {
          icon: "external-link",
          label: "Use on this Mac",
          onSelect: () =>
            void act(null, { label: "use this on this Mac" }, () =>
              useHere.use(
                { viewId: useHere.view.viewId, generation: useHere.view.generation },
                useHere.app,
              ),
            ).catch(failed),
        },
      ]
    : [];
  const reopen: SurfaceMenuItem = {
    icon: "reload",
    label: "Reopen closed tab",
    onSelect: () => {
      const show = nav.beginPlaceOperation();
      void act(hostClient, { label: "reopen the tab", done: "reopened" }, () =>
        hostClient.reopenTab(),
      ).then((tab) => show({ kind: "tab", tabId: tab.tabId }), failed);
    },
  };
  const closing: SurfaceMenuItem = {
    detail:
      place.kind === "page"
        ? undefined
        : place.occupants.length > 0
          ? "Work there carries on"
          : undefined,
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
  const words = presentation ? browserWords(presentation, hereId) : null;
  const device = presentation ? deviceElsewhere(machines, presentation.computerId, hereId) : null;
  const organize = (group: TabOrganizeInput["group"]) => {
    onClose();
    return act(hostClient, { label: "move this tab", done: "moved" }, () =>
      hostClient.organizeTabs({ tabIds: [tabId], group }),
    );
  };
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
          <span className="tab-menu__name">{presentation.identity.name}</span>
          {device ? <DeviceLabel device={device} /> : null}
        </div>
      ) : null}
      {pageItems.length || nativeItems.length ? (
        <div className="picker__section">
          {[...pageItems, ...nativeItems].map((item) => (
            <SurfaceMenuRow item={item} key={item.label} onChoose={choose(item)} />
          ))}
          {page ? (
            <OpenInRow
              disabled={!url}
              hostClient={hostClient}
              onDone={() => {
                onClose();
                anchor.focus();
              }}
              place={place}
              presentation={presentation}
            />
          ) : null}
          {copying.map((item) => (
            <SurfaceMenuRow item={item} key={item.label} onChoose={choose(item)} />
          ))}
        </div>
      ) : null}
      <div className="picker__section">
        <SurfaceSubmenuRow icon="plus" label="Add to group">
          <div className="picker__section">
            <SurfaceMenuRow
              item={{ icon: "plus", label: "New group" }}
              onChoose={() =>
                void organize({ name: "New group", color: nextGroupColor(groups) }).then(
                  (result) => onEditGroup(groupOf(result.groups, tabId)),
                  failed,
                )
              }
            />
          </div>
          {otherGroups.length > 0 ? (
            <div className="picker__section">
              {otherGroups.map((group) => (
                <button
                  className="picker__row"
                  key={group.groupId}
                  onClick={() => void organize({ groupId: group.groupId }).catch(failed)}
                  role="menuitem"
                  type="button"
                >
                  <span className="picker__check">
                    <span className="tab-group-dot" style={tabGroupStyle(group.color)} />
                  </span>
                  <span className="picker__label">{group.name}</span>
                </button>
              ))}
            </div>
          ) : null}
        </SurfaceSubmenuRow>
        {currentGroup ? (
          <SurfaceMenuRow
            item={{ icon: "browser", label: "Remove from group" }}
            onChoose={() => void organize(null).catch(failed)}
          />
        ) : null}
      </div>
      <div className="picker__section">
        <SurfaceMenuRow item={closing} onChoose={choose(closing)} />
        <SurfaceMenuRow item={reopen} onChoose={choose(reopen)} />
      </div>
    </Popover>
  );
}

/** The colour used least so far, as a new group's. */
export function nextGroupColor(groups: readonly TabGroup[]): TabGroupColor {
  return TabGroupColorSchema.options.reduce((least, color) =>
    groups.filter((group) => group.color === color).length <
    groups.filter((group) => group.color === least).length
      ? color
      : least,
  );
}
function groupOf(groups: readonly TabGroup[], tabId: TabId): string | null {
  return groups.find((group) => group.tabIds.includes(tabId))?.groupId ?? null;
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
