import { OmniboxResults, useOmnibox, omniboxChoosable as choosable } from "../browser/omnibox.js";
import { threadMark } from "@opensteer/client/host";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { z } from "zod";
import {
  HostClientRequestError,
  mainWorkspace,
  mutationIdempotencyKey,
  sameIdentity,
  startPageChoice,
  startPageIndex,
  webSearchUrl,
  type BrowserIdentityChoice,
  type BrowserTabOpenInput,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type StartPageGroup,
  type StartPageProfileChoice,
  type StartPageResult,
} from "@opensteer/client/host";
import {
  computerNotReadyStatus,
  computerReasonWords,
  type ComputerNotReady,
} from "@opensteer/client/integrations";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
import type { ApprovedComputerApp, OwnerWindowInfo } from "@opensteer/protocol";
import { actionErrorMessage } from "../../ui-utils.js";
import { WorkspaceBrowserProfiles } from "../browser/browser-view.js";
import { browserTargetViewport } from "../browser/browser-viewport.js";
import { AppMark } from "../computer-apps/computer-use-section.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { SiteMark } from "../site-mark.js";
import { useToastToolbar } from "../toast.js";
import { TaskMark, ChatOrb } from "./task-mark.js";
import { ProfileAvatar, guestDetail } from "./identity.js";
import {
  destinationPlaceKey,
  placeSelection,
  type PlaceMemoryScope,
  type StartPageLink,
} from "./navigation.js";
import { useFocusRescue } from "./occupant-marks.js";
import { ownerViewDestination } from "./owner-views.js";
import { useWorkspace } from "./workspace-context.js";

/* ---- The person's last explicit choice of profile, per deployment and user ---- */

const ChoiceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("profile"), profileId: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("guest") }),
]);

function choiceKey(scope: PlaceMemoryScope): string | null {
  return scope.deploymentId && scope.userId
    ? `opensteer.browse-with.v1:${encodeURIComponent(scope.deploymentId)}:${encodeURIComponent(scope.userId)}`
    : null;
}

/** The profile the person last picked or opened something with; nothing when unreadable. */
export function lastBrowsingChoice(scope: PlaceMemoryScope): BrowserIdentityChoice | null {
  const key = choiceKey(scope);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw.length > 512) return null;
    return ChoiceSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

/** Only a person's explicit pick or open: background work never writes it. */
export function rememberBrowsingChoice(scope: PlaceMemoryScope, choice: BrowserIdentityChoice) {
  const key = choiceKey(scope);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(choice));
  } catch {
    // A convenience only: without it the next start page begins at Guest.
  }
}

/* ---- New tab ---- */

/**
 * ⌘T and every `+`: the start page, focused, with nothing opened anywhere
 * until the person chooses. On the start page already, its field takes the
 * keyboard again.
 */
export function useNewTab() {
  const { nav, selection, startPage } = useWorkspace();
  return useCallback(() => {
    if (selection.kind === "launcher") {
      startPage.focus();
      return;
    }
    nav.showLauncher();
  }, [nav, selection, startPage]);
}

/* ---- The start page ---- */

const selectStart = (snapshot: HostSnapshot) => snapshot;
function sameStart(left: HostSnapshot, right: HostSnapshot): boolean {
  return (
    left.threads === right.threads &&
    left.tasks === right.tasks &&
    left.activeTasks === right.activeTasks &&
    left.workspaceTasks === right.workspaceTasks &&
    left.homeThreadId === right.homeThreadId &&
    left.browserSessions === right.browserSessions &&
    left.browserProfiles === right.browserProfiles &&
    left.browserPlacements === right.browserPlacements &&
    left.browserProfileGrants === right.browserProfileGrants &&
    left.browserAvailable === right.browserAvailable &&
    left.machines === right.machines &&
    left.ownerViewWindowsAvailable === right.ownerViewWindowsAvailable &&
    left.connection === right.connection &&
    left.deploymentShape === right.deploymentShape &&
    left.homeWorkspaceId === right.homeWorkspaceId &&
    left.workspaces === right.workspaces &&
    left.deploymentId === right.deploymentId &&
    left.user === right.user
  );
}

/** Read once per client and kept for the next start page, so it never opens empty-handed. */
const approvedAppsCache = new WeakMap<HostClient, readonly ApprovedComputerApp[]>();

type Refusal =
  | { readonly kind: "message"; readonly text: string; readonly pick?: boolean }
  | {
      readonly kind: "choose-computer";
      readonly result: StartPageResult;
      readonly text: string;
    };

/** How many app tiles a computer's row shows before All apps: the first computer's more. */
const appsShown = { first: 5, other: 3 } as const;

/** A computer's own page: its apps, and the steps when it needs its owner. */
function computerPage(machineId: string): string {
  return `/settings/computers/${encodeURIComponent(machineId)}`;
}

/**
 * New tab: one field for websites and apps, the profile it browses with, the
 * selected profile's recent sites, and the apps and phones the person may
 * open. Typing replaces the tiles with one list whose rows say what Enter
 * does. Nothing here changes any browser until the person opens something,
 * and what opens is exactly what the row said.
 */
export const StartPage = memo(function StartPage({
  from,
  hostClient,
  leading,
  link,
  trailing,
}: {
  /** The place query this page was opened over, where Esc and × return. */
  readonly from: string | null;
  readonly hostClient: HostClient;
  readonly leading: ReactNode;
  /** A link's address, typed in; opened on arrival unless this entry already did. */
  readonly link: StartPageLink | null;
  readonly trailing: ReactNode;
}) {
  const { localMachine, nav, phone, startPage } = useWorkspace();
  const toolbarRef = useToastToolbar();
  const navigate = useNavigate();
  const location = useLocation();
  const arrived = useRef(false);
  const snapshot = useHostSelector(hostClient, selectStart, sameStart);
  const places = usePlaceList(hostClient);
  const scope = useMemo<PlaceMemoryScope>(
    () => ({ deploymentId: snapshot.deploymentId, userId: snapshot.user?.id ?? null }),
    [snapshot.deploymentId, snapshot.user?.id],
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Where the keyboard goes when the row it was on folds or opens up.
  const toField = useRef(() => inputRef.current);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  // The default is decided once, as the page opens: background work after
  // that never changes it, and only the person's pick does.
  const [choice, setChoice] = useState<BrowserIdentityChoice>(() => {
    const source = from ? placeSelection(new URLSearchParams(from)) : null;
    const key = source?.kind === "place" ? destinationPlaceKey(source.destination) : null;
    return startPageChoice({
      sourcePlace: key ? (places.find((place) => place.key === key) ?? null) : null,
      lastChoice: lastBrowsingChoice(scope),
    });
  });
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [recentMenu, setRecentMenu] = useState<{
    readonly anchor: HTMLElement;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const pickerRef = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The field has the keyboard as the page appears, before anything is read.
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const [approvedApps, setApprovedApps] = useState<readonly ApprovedComputerApp[]>(
    () => approvedAppsCache.get(hostClient) ?? [],
  );
  const connected = snapshot.connection === "connected";
  useEffect(() => {
    if (!connected || !scope.userId) return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = (failures: number) =>
      void hostClient.listApprovedComputerApps().then(
        (apps) => {
          approvedAppsCache.set(hostClient, apps);
          if (current) setApprovedApps(apps);
        },
        // Meanwhile the tiles stay as last known and typing still finds open places.
        // A Host or Runner restarting (an update does both) refuses reads for a moment,
        // so a tab that stays open reads again rather than never showing its apps.
        () => {
          if (current)
            retry = setTimeout(() => read(failures + 1), Math.min(30_000, 1_000 * 2 ** failures));
        },
      );
    read(0);
    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [connected, hostClient, scope.deploymentId, scope.userId]);

  const localMachineId = localMachine?.machineId ?? null;
  const index = useMemo(
    () => startPageIndex({ snapshot, places, approvedApps, localMachineId, choice }),
    [approvedApps, choice, localMachineId, places, snapshot],
  );
  const historyRevision = useSyncExternalStore(
    hostClient.recentSites.subscribe,
    hostClient.recentSites.getRevision,
  );
  const recents = useMemo(
    () => hostClient.recentSites.list(choice),
    [choice, hostClient, historyRevision, scope],
  );
  const omnibox = useOmnibox({
    hostClient,
    index,
    choice,
    inputRef,
    initialValue: link?.address ?? "",
    includeApps: true,
    onChoose: (result) => void run(result),
    onEdit: () => setRefusal(null),
    onFocusPage: () => leave(),
    onEmptyDown: () => stageRef.current?.querySelector<HTMLElement>("[data-start-tile]")?.focus(),
  });
  const { raw: query, setText: setQuery, rows: results } = omnibox;
  const selected =
    index.profiles.find((profile) => sameIdentity(profile.identity, choice)) ??
    index.profiles.at(-1)!;
  const leave = useCallback(() => nav.leaveLauncher(from), [from, nav]);
  useEffect(
    () =>
      startPage.register(leave, () => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }),
    [leave, startPage],
  );

  const pick = (identity: BrowserIdentityChoice) => {
    setChoice(identity);
    setRefusal(null);
    rememberBrowsingChoice(scope, identity);
    inputRef.current?.focus();
  };

  const fail = (error: unknown, result: StartPageResult) => {
    if (!mounted.current) return;
    const reason = error instanceof HostClientRequestError ? error.reason : undefined;
    const name = selected.presentation.name;
    if (reason === "browser-placement-ambiguous")
      setRefusal({
        kind: "choose-computer",
        result,
        text: `Which computer should ${name} browse on?`,
      });
    else if (reason === "browser-placement-unavailable")
      setRefusal({
        kind: "message",
        text: `${name}’s computer isn’t available right now. Choose another profile, or try again when it’s back.`,
        pick: true,
      });
    else if (reason === "browser-profile-unavailable")
      setRefusal({
        kind: "message",
        text: `${name} isn’t available anymore. Choose another profile.`,
        pick: true,
      });
    else if (reason?.startsWith("computer-view"))
      setRefusal({
        kind: "message",
        text: computerReasonWords(reason, {
          machine:
            snapshot.machines.find(
              (machine) =>
                result.action.kind === "open-computer-view" &&
                machine.id === result.action.machineId,
            )?.name ?? "This computer",
          phone: result.kind === "phone",
          target: result.title,
        }),
      });
    else setRefusal({ kind: "message", text: actionErrorMessage(error) });
  };

  const run = async (
    result: StartPageResult,
    placement?: { readonly kind: "runner"; readonly runnerId: string },
  ) => {
    const { action } = result;
    if (pending !== null) return;
    setRefusal(null);
    if (result.notReady) {
      // Its row already says why; one its owner can fix opens the computer's page, with the steps.
      if (choosable(result) && action.kind === "open-computer-view")
        void navigate(computerPage(action.machineId));
      return;
    }
    if (!result.available) {
      setRefusal({ kind: "message", text: unavailableWords(result, selected, snapshot) });
      return;
    }
    if (action.kind === "switch-to-place") {
      nav.beginPlaceOperation({ replace: true })(action.destination);
      return;
    }
    const show = nav.beginPlaceOperation({ replace: true });
    setPending(result.key);
    try {
      if (action.kind === "open-computer-view") {
        const view = await hostClient.openComputerView(action.machineId, action.target);
        show(ownerViewDestination(view));
        return;
      }
      const url = action.kind === "open-url" ? action.url : webSearchUrl(action.query);
      // The page starts at the size it will be shown at, floor and all.
      const viewport = browserTargetViewport(
        stageRef.current?.getBoundingClientRect() ?? null,
        phone,
      );
      const epoch = hostClient.recentSites.epoch;
      const target: BrowserTabOpenInput = { ...action.target, ...(placement ? { placement } : {}) };
      const opened = await hostClient.openBrowserTab(target, {
        url,
        ...(viewport ? { viewport } : {}),
        idempotencyKey: mutationIdempotencyKey("start-page-open"),
      });
      hostClient.recentSites.record(choice, url, epoch, {
        title:
          hostClient
            .getSnapshot()
            .browserSessions.find((session) => session.id === opened.sessionId)
            ?.tabs.find((tab) => tab.id === opened.tabId)?.title ?? "",
        typed: result.kind === "address",
        tab: opened,
      });
      rememberBrowsingChoice(scope, choice);
      show({ kind: "browser", sessionId: opened.sessionId, tabId: opened.tabId });
    } catch (error) {
      fail(error, result);
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  useEffect(() => {
    if (!link?.open || arrived.current) return;
    const result = results.find((item) => item.key === "navigate");
    if (!result) return;
    // History owns consumption across reload and Back; the ref absorbs StrictMode's second effect.
    arrived.current = true;
    const state: unknown = location.state;
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      {
        replace: true,
        state: { ...(typeof state === "object" && state !== null ? state : {}), startOpen: false },
      },
    );
    void run(result);
  }, [link, location, navigate, results, run]);

  const typed = query.trim() !== "";
  const onPageKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query) {
        setQuery("");
        setRefusal(null);
        inputRef.current?.focus();
      } else leave();
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.dataset.startTile !== undefined &&
      ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)
    ) {
      event.preventDefault();
      const moved = moveBetweenTiles(target, event.key, stageRef.current);
      if (!moved && event.key === "ArrowUp") inputRef.current?.focus();
    }
  };

  const firstRun = snapshot.browserProfiles.length === 0;
  const main = mainWorkspace(snapshot);
  const browsing = snapshot.browserAvailable && snapshot.browserPlacements.length > 0;
  const occupants = useMemo(() => {
    const byKey = new Map<string, PlaceItem>();
    for (const place of places) if (place.kind !== "browser") byKey.set(place.key, place);
    return byKey;
  }, [places]);

  return (
    <div className="browser-view start-page-view">
      <div className="browser-toolbar surface-row start-page__bar" ref={toolbarRef}>
        {leading}
        <div aria-hidden className="browser-controls start-page__controls">
          <button disabled tabIndex={-1} type="button">
            <Icon name="arrow-left" />
          </button>
          <button disabled tabIndex={-1} type="button">
            <Icon name="arrow-right" />
          </button>
          <button disabled tabIndex={-1} type="button">
            <Icon name="reload" />
          </button>
        </div>
        <span className="launcher__spacer" />
        {trailing}
      </div>
      <div className="start-page" onKeyDown={onPageKey} ref={stageRef}>
        <div className="start-page__column">
          <form
            className="start-page__field"
            onSubmit={(event) => event.preventDefault()}
            role="search"
          >
            {pending !== null ? (
              <span aria-hidden className="spinner start-page__spinner" />
            ) : (
              <Icon className="start-page__glass" name="search" />
            )}
            <input
              {...omnibox.inputProps}
              aria-label="Search websites and apps"
              className="start-page__input"
              enterKeyHint="go"
              placeholder="Search websites and apps"
              ref={inputRef}
            />
            {query ? (
              <button
                aria-label="Clear"
                className="start-page__clear"
                onClick={() => {
                  setQuery("");
                  setRefusal(null);
                  inputRef.current?.focus();
                }}
                type="button"
              >
                <Icon name="close" />
              </button>
            ) : null}
          </form>

          <div className="start-page__with">
            <span className="start-page__with-label">Browse with</span>
            <button
              aria-expanded={pickerOpen}
              aria-haspopup="menu"
              aria-label={`Browse with ${selected.presentation.name}. Change`}
              className={pickerOpen ? "start-page__pill is-open" : "start-page__pill"}
              onClick={() => setPickerOpen((open) => !open)}
              ref={pickerRef}
              title={selected.presentation.name}
              type="button"
            >
              <ProfileAvatar identity={selected.presentation} size={18} />
              <span className="start-page__pill-name">{selected.presentation.name}</span>
              <Icon className="start-page__chevron" name="chevron-down" />
            </button>
            {firstRun ? (
              <>
                <span aria-hidden className="start-page__dot">
                  ·
                </span>
                <button
                  className="start-page__link"
                  onClick={() => void navigate("/settings/chrome")}
                  type="button"
                >
                  Use Chrome sign-ins
                </button>
              </>
            ) : null}
          </div>

          {refusal ? (
            <div className="start-page__refusal" role="alert">
              <span>{refusal.text}</span>
              {refusal.kind === "choose-computer" ? (
                <span className="start-page__refusal-actions">
                  {snapshot.browserPlacements
                    .filter((placement) => placement.available)
                    .map((placement) => (
                      <button
                        className="btn btn--small"
                        key={placement.runnerId}
                        onClick={() =>
                          void run(refusal.result, {
                            kind: "runner",
                            runnerId: placement.runnerId,
                          })
                        }
                        type="button"
                      >
                        <Icon name="laptop" />
                        {placement.label}
                      </button>
                    ))}
                </span>
              ) : refusal.pick ? (
                <button
                  className="btn btn--small"
                  onClick={() => setPickerOpen(true)}
                  type="button"
                >
                  Choose a profile
                </button>
              ) : null}
            </div>
          ) : null}

          {typed ? (
            <OmniboxResults controller={omnibox} hostClient={hostClient} pending={pending} />
          ) : (
            <>
              {!browsing ? (
                <p className="start-page__quiet">
                  No computer can browse right now.{" "}
                  <button
                    className="start-page__link"
                    onClick={() => void navigate("/settings/computers")}
                    type="button"
                  >
                    Computers
                  </button>
                </p>
              ) : null}
              {recents.length > 0 ? (
                <section aria-label={`Recent sites · ${selected.presentation.name}`}>
                  <ul className="start-page__recents">
                    {recents.slice(0, 12).map((recent) => {
                      const host = new URL(recent.origin).host.replace(/^www\./u, "");
                      const result: StartPageResult = {
                        key: `recent:${recent.origin}`,
                        kind: "recent",
                        title: host,
                        detail: null,
                        label: "",
                        available: selected.available,
                        action: {
                          kind: "open-url",
                          target: { identity: choice },
                          url: `${recent.origin}/`,
                        },
                      };
                      return (
                        <li key={recent.origin}>
                          <button
                            aria-label={`${host} — open in ${selected.presentation.name}`}
                            className="start-tile"
                            data-start-tile=""
                            onClick={() => void run(result)}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setRecentMenu({
                                anchor: event.currentTarget,
                                x: event.clientX,
                                y: event.clientY,
                              });
                            }}
                            onKeyDown={(event) => {
                              if (
                                event.key === "ContextMenu" ||
                                (event.key === "F10" && event.shiftKey)
                              ) {
                                event.preventDefault();
                                const box = event.currentTarget.getBoundingClientRect();
                                setRecentMenu({
                                  anchor: event.currentTarget,
                                  x: box.left + 8,
                                  y: box.bottom,
                                });
                              }
                            }}
                            title={host}
                            type="button"
                          >
                            <span className="start-tile__site">
                              <SiteMark favicon={recent.favicon} site={host} />
                            </span>
                            <span className="start-tile__label">{host}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}
              {index.groups.length > 0 ? (
                <section aria-labelledby={`${listId}-apps`} className="start-page__apps">
                  <h2 className="start-page__heading" id={`${listId}-apps`}>
                    Apps &amp; devices
                  </h2>
                  {/* Rows that open, then the computers that can't, in a list of their own:
                      one changing never moves the others under the keyboard. */}
                  {index.groups
                    .filter((group) => group.readiness === null)
                    .map((group, order) => (
                      <AppRow
                        hostClient={hostClient}
                        snapshot={snapshot}
                        first={order === 0}
                        expanded={expanded.has(`${group.kind}:${group.machineId}`)}
                        group={group}
                        index={index}
                        key={`${group.kind}:${group.machineId}`}
                        occupants={occupants}
                        onAddApp={() => void navigate(computerPage(group.machineId))}
                        onOpen={(result) => void run(result)}
                        onToggle={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            const key = `${group.kind}:${group.machineId}`;
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                        pending={pending}
                        rescue={toField}
                      />
                    ))}
                  {index.groups.some((group) => group.readiness !== null) ? (
                    <div className="start-apps__away">
                      {index.groups.map((group) =>
                        group.readiness === null ? null : (
                          <AwayRow
                            group={group}
                            // A line that stops or starts being a button is a new control, so
                            // one that held the keyboard hands it on as it goes.
                            key={`${group.kind}:${group.machineId}:${computerNotReadyStatus(group.readiness).tone}`}
                            onOpen={() => void navigate(computerPage(group.machineId))}
                            readiness={group.readiness}
                            rescue={toField}
                          />
                        ),
                      )}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
      {pickerOpen && pickerRef.current ? (
        <BrowseWithMenu
          anchor={pickerRef.current}
          choice={choice}
          firstRun={firstRun}
          onAddProfile={() => {
            setPickerOpen(false);
            setProfilesOpen(true);
          }}
          onClose={() => setPickerOpen(false)}
          onManage={() => {
            setPickerOpen(false);
            setProfilesOpen(true);
          }}
          onPick={(identity) => {
            setPickerOpen(false);
            pick(identity);
          }}
          guestComputer={
            places.find(
              (place) => place.identity?.kind === "guest" && place.browser?.opener.kind === "you",
            )?.device?.name ?? null
          }
          profiles={index.profiles}
        />
      ) : null}
      {recentMenu ? (
        <Popover
          anchor={recentMenu.anchor}
          at={recentMenu}
          className="popover--surface"
          label="Recent sites"
          onClose={() => setRecentMenu(null)}
        >
          <div className="picker__section">
            <button
              className="picker__row"
              onClick={() => {
                hostClient.recentSites.clear(choice);
                omnibox.refreshHistory();
                setRecentMenu(null);
                inputRef.current?.focus();
              }}
              role="menuitem"
              type="button"
            >
              <span className="picker__check picker__check--icon">
                <Icon name="trash" />
              </span>
              <span className="picker__label-stack">
                <span className="picker__label">Clear browsing history</span>
                <span className="picker__detail">
                  For {selected.presentation.name} on this device
                </span>
              </span>
            </button>
          </div>
        </Popover>
      ) : null}
      {profilesOpen && main ? (
        <WorkspaceBrowserProfiles
          available={snapshot.browserAvailable}
          hostClient={hostClient}
          onClose={() => {
            setProfilesOpen(false);
            inputRef.current?.focus();
          }}
          profileGrants={snapshot.browserProfileGrants}
          profiles={snapshot.browserProfiles}
          workspace={main}
        />
      ) : null}
    </div>
  );
});

function unavailableWords(
  result: StartPageResult,
  selected: StartPageProfileChoice,
  snapshot: HostSnapshot,
): string {
  if (snapshot.connection !== "connected")
    return "Opensteer is reconnecting. Try again in a moment.";
  if (result.action.kind === "switch-to-place") return `${result.title} isn’t available right now.`;
  if (selected.presentation.kind === "profile" && !selected.presentation.available)
    return `${selected.presentation.name} isn’t available anymore. Choose another profile.`;
  if (!snapshot.browserAvailable || snapshot.browserPlacements.length === 0)
    return "No computer can browse right now.";
  return `${selected.presentation.name}’s computer, ${selected.computerLabel}, isn’t available right now.`;
}

/* ---- Results ---- */

/* ---- Apps & devices ---- */

function AppWindows({
  app,
  hostClient,
  machineName,
  onOpen,
}: {
  readonly app: ApprovedComputerApp;
  readonly hostClient: HostClient;
  readonly machineName: string;
  readonly onOpen: (result: StartPageResult) => void;
}) {
  const [windows, setWindows] = useState<readonly OwnerWindowInfo[]>([]);
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const popupId = useId();
  useEffect(() => {
    let cancelled = false;
    if (app.target.kind === "app")
      void hostClient
        .listComputerAppWindows(app.machineId, app.target.app)
        .then((windows) => {
          if (!cancelled) setWindows(windows);
        })
        .catch(() => {
          if (!cancelled) setWindows([]);
        });
    return () => {
      cancelled = true;
    };
  }, [app, hostClient]);
  if (windows.length < 2 || app.target.kind !== "app") return null;
  const target = app.target;
  return (
    <div className="start-app-windows-toggle">
      <button
        ref={toggleRef}
        aria-haspopup="dialog"
        aria-controls={expanded ? popupId : undefined}
        aria-expanded={expanded}
        aria-label={`Windows of ${app.name} on ${machineName}`}
        className="start-app-windows__toggle"
        data-start-tile=""
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {windows.length} windows
      </button>
      {expanded && toggleRef.current ? (
        <Popover
          anchor={toggleRef.current}
          className="start-app-windows"
          id={popupId}
          label={`Windows of ${app.name}`}
          onClose={() => setExpanded(false)}
        >
          <ul>
            {windows.map((window) => (
              <li key={window.id}>
                <button
                  aria-label={`${app.name} — ${window.title || "Untitled window"}`}
                  data-start-tile=""
                  onClick={() =>
                    onOpen({
                      key: `window:${app.connectionId}:${window.id}`,
                      kind: "app",
                      title: `${app.name} — ${window.title || "Untitled window"}`,
                      detail: machineName,
                      label: "Open window",
                      available: true,
                      app,
                      action: {
                        kind: "open-computer-view",
                        machineId: app.machineId,
                        target: { ...target, window: window.id },
                      },
                    })
                  }
                  type="button"
                >
                  <span>{window.title || "Untitled window"}</span>
                  {window.minimized ? (
                    <small>Minimized</small>
                  ) : !window.onScreen ? (
                    <small>Other Space</small>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </div>
  );
}

function AppRow({
  hostClient,
  expanded,
  first,
  group,
  index,
  occupants,
  snapshot,
  onAddApp,
  onOpen,
  onToggle,
  pending,
  rescue,
}: {
  readonly hostClient: HostClient;
  readonly expanded: boolean;
  readonly first: boolean;
  readonly group: StartPageGroup;
  readonly index: ReturnType<typeof startPageIndex>;
  readonly occupants: ReadonlyMap<string, PlaceItem>;
  readonly snapshot: HostSnapshot;
  /** The computer's own page, where its owner approves another app. */
  readonly onAddApp: () => void;
  readonly onOpen: (result: StartPageResult) => void;
  readonly onToggle: () => void;
  readonly pending: string | null;
  readonly rescue: { readonly current: () => HTMLElement | null };
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusRescue(ref, rescue);
  const limit = first ? appsShown.first : appsShown.other;
  const more = group.items.length > limit + 1;
  const shown = more && !expanded ? group.items.slice(0, limit) : group.items;
  const phone = group.kind === "phone";
  return (
    <div className="start-apps__row" ref={ref}>
      <div className="start-apps__caption">
        <Icon name={phone ? "phone" : "laptop"} />
        <span>{phone ? "Phone" : group.label}</span>
      </div>
      <ul className="start-apps__tiles">
        {shown.map((app) => {
          const indexed = index.apps.find((candidate) => candidate.app === app);
          const held =
            [...occupants.values()].find(
              (place) =>
                place.device?.machineId === app.machineId &&
                (place.icon.kind === "app" && app.target.kind === "app"
                  ? place.icon.app.bundleId.toLowerCase() === app.target.app.bundleId.toLowerCase()
                  : place.kind === "phone" && app.target.kind === "phone"),
            ) ?? null;
          // The person's own view switches; a task's hold on the app opens the person's own view.
          const open = phone && held?.ownerView ? held : null;
          const occupant = held?.occupants[0] ?? null;
          const available = open
            ? open.availability !== "unavailable"
            : (indexed?.available ?? false);
          const result: StartPageResult = open
            ? {
                key: `open:${app.connectionId}`,
                kind: "tab",
                title: app.name,
                detail: phone ? null : group.label,
                label: "Switch to view",
                available,
                action: {
                  kind: "switch-to-place",
                  destination: open.destination,
                  placeKey: open.key,
                },
                place: open,
              }
            : {
                key: `open:${app.connectionId}`,
                kind: phone ? "phone" : "app",
                title: app.name,
                detail: phone ? null : group.label,
                label: phone ? `Open ${app.name}` : `Open ${app.name} · ${group.label}`,
                available,
                action: {
                  kind: "open-computer-view",
                  machineId: app.machineId,
                  target: app.target,
                },
                app,
              };
          return (
            <li key={app.connectionId}>
              <button
                aria-label={
                  phone
                    ? `${app.name}${open ? ", open" : ""}`
                    : `${app.name} on ${group.label}${open ? ", open" : ""}`
                }
                className={available ? "start-tile" : "start-tile is-unavailable"}
                data-start-tile=""
                onClick={() => onOpen(result)}
                title={phone ? app.name : `${app.name} · ${group.label}`}
                type="button"
              >
                <span className="start-tile__app">
                  {pending === result.key ? (
                    <span aria-hidden className="spinner" />
                  ) : app.target.kind === "app" ? (
                    <AppMark
                      iconPng={app.iconPng ?? undefined}
                      identity={app.target.app}
                      machineId={app.machineId}
                    />
                  ) : (
                    <PhoneDrawing />
                  )}
                  {occupant ? (
                    <span className="start-tile__mark">
                      {occupant.home ? (
                        <ChatOrb size={16} />
                      ) : (
                        <TaskMark size={16} mark={threadMark(occupant.threadId, snapshot)} />
                      )}
                    </span>
                  ) : null}
                </span>
                <span className="start-tile__label">{app.name}</span>
              </button>
              {app.target.kind === "app" && snapshot.ownerViewWindowsAvailable && available ? (
                <AppWindows
                  app={app}
                  hostClient={hostClient}
                  machineName={group.label}
                  onOpen={onOpen}
                />
              ) : null}
            </li>
          );
        })}
        {!phone && (!more || expanded) && shown.length < 24 ? (
          <li>
            <button
              aria-label={`Add an app on ${group.label}`}
              className="start-tile"
              data-start-tile=""
              onClick={onAddApp}
              type="button"
            >
              <span aria-hidden className="start-tile__app start-tile__all">
                <Icon name="plus" />
              </span>
              <span className="start-tile__label">Add app</span>
            </button>
          </li>
        ) : null}
        {more ? (
          <li>
            <button
              aria-expanded={expanded}
              className="start-tile"
              data-start-tile=""
              onClick={onToggle}
              type="button"
            >
              <span aria-hidden className="start-tile__app start-tile__all">
                <AllAppsGlyph />
              </span>
              <span className="start-tile__label">{expanded ? "Fewer" : "All apps"}</span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * A computer that can't show its apps now, folded to its name and why. One
 * that is only away offers nothing to do; one waiting on its owner opens its
 * page, where the steps are. Its apps unfold in their own row when it's back.
 */
function AwayRow({
  group,
  onOpen,
  readiness,
  rescue,
}: {
  readonly group: StartPageGroup;
  readonly onOpen: () => void;
  readonly readiness: ComputerNotReady;
  readonly rescue: { readonly current: () => HTMLElement | null };
}) {
  const ref = useRef<HTMLElement | null>(null);
  useFocusRescue(ref, rescue);
  const phone = group.kind === "phone";
  const status = computerNotReadyStatus(readiness);
  const why = computerReasonWords(readiness, { machine: group.label, phone, target: "its apps" });
  const line = (
    <>
      <span className="start-apps__caption">
        <Icon name={phone ? "phone" : "laptop"} />
        <span>{group.label}</span>
      </span>
      <span className="start-apps__status">
        <span aria-hidden className={`start-apps__dot start-apps__dot--${status.tone}`} />
        {status.label}
      </span>
    </>
  );
  return status.tone === "attention" ? (
    <button
      aria-label={`${group.label}, ${status.label}`}
      className="start-apps__row start-apps__row--away"
      data-start-tile=""
      onClick={onOpen}
      ref={(node) => {
        ref.current = node;
      }}
      title={why}
      type="button"
    >
      {line}
    </button>
  ) : (
    <div className="start-apps__row start-apps__row--away" title={why}>
      {line}
    </div>
  );
}

/** A phone, drawn: a device, not an app and not a profile. */
function PhoneDrawing() {
  return (
    <svg aria-hidden className="start-tile__phone" viewBox="0 0 28 44">
      <rect
        x="2"
        y="1"
        width="24"
        height="42"
        rx="5"
        fill="#2b3a55"
        stroke="#8ea6cf"
        strokeWidth="1.4"
      />
      <rect x="4.5" y="4.5" width="19" height="35" rx="2.5" fill="#6f93d6" />
      <rect x="11" y="2.6" width="6" height="1.2" rx="0.6" fill="#8ea6cf" />
    </svg>
  );
}

function AllAppsGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 18 18">
      {[3, 9, 15].flatMap((y) =>
        [3, 9, 15].map((x) => <circle cx={x} cy={y} key={`${x}-${y}`} r="1.6" />),
      )}
    </svg>
  );
}

/** Arrow keys between tiles: the nearest tile that way, by where it is on screen. */
function moveBetweenTiles(from: HTMLElement, key: string, root: HTMLElement | null): boolean {
  if (!root) return false;
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  let best: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const tile of root.querySelectorAll<HTMLElement>("[data-start-tile]")) {
    if (tile === from) continue;
    const b = tile.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const ahead =
      key === "ArrowRight"
        ? dx > 4
        : key === "ArrowLeft"
          ? dx < -4
          : key === "ArrowDown"
            ? dy > 4
            : dy < -4;
    if (!ahead) continue;
    // Along a row first; down and up keep to the column.
    const score = horizontal ? Math.abs(dx) + Math.abs(dy) * 4 : Math.abs(dy) * 2 + Math.abs(dx);
    if (horizontal && Math.abs(dy) > a.height / 2) continue;
    if (score < bestScore) {
      best = tile;
      bestScore = score;
    }
  }
  best?.focus();
  return best !== null;
}

/* ---- Browse with ---- */

function BrowseWithMenu({
  anchor,
  choice,
  firstRun,
  guestComputer,
  onAddProfile,
  onClose,
  onManage,
  onPick,
  profiles,
}: {
  readonly anchor: HTMLElement;
  readonly choice: BrowserIdentityChoice;
  readonly firstRun: boolean;
  /** Where the person's own Guest browser is open, when it is. */
  readonly guestComputer: string | null;
  readonly onAddProfile: () => void;
  readonly onClose: () => void;
  readonly onManage: () => void;
  readonly onPick: (identity: BrowserIdentityChoice) => void;
  readonly profiles: readonly StartPageProfileChoice[];
}) {
  return (
    <Popover
      anchor={anchor}
      below
      className="popover--surface popover--profiles"
      label="Browse with"
      onClose={onClose}
    >
      <div className="picker__section">
        {profiles.map((profile) => {
          const checked = sameIdentity(profile.identity, choice);
          const guest = profile.identity.kind === "guest";
          const detail = guest
            ? profile.yours
              ? `Your Guest browser is open${guestComputer ? ` on ${guestComputer}` : ""}. Tabs reopen; sign-ins aren’t saved.`
              : guestDetail
            : !profile.available
              ? profile.presentation.kind === "profile" && !profile.presentation.available
                ? "No longer available"
                : `Unavailable · ${profile.computerLabel}`
              : profile.computerLabel;
          return (
            <button
              aria-checked={checked}
              className="picker__row"
              key={
                guest
                  ? "guest"
                  : profile.identity.kind === "profile"
                    ? profile.identity.profileId
                    : ""
              }
              onClick={() => onPick(profile.identity)}
              role="menuitemradio"
              type="button"
            >
              <ProfileAvatar identity={profile.presentation} size={18} />
              <span className="picker__label-stack">
                <span className="picker__label">{profile.presentation.name}</span>
                <span className="picker__detail picker__detail--wrap">{detail}</span>
              </span>
              {checked ? <Icon className="picker__tick" name="check" /> : null}
            </button>
          );
        })}
      </div>
      <div className="picker__section">
        <button className="picker__row" onClick={onAddProfile} role="menuitem" type="button">
          <span className="picker__check picker__check--icon">
            <Icon name="plus" />
          </span>
          <span className="picker__label-stack">
            <span className="picker__label">Add profile…</span>
            {firstRun ? <span className="picker__detail">Or use your Chrome sign-ins</span> : null}
          </span>
        </button>
        {firstRun ? null : (
          <button className="picker__row" onClick={onManage} role="menuitem" type="button">
            <span className="picker__check picker__check--icon">
              <Icon name="settings" />
            </span>
            <span className="picker__label">Manage profiles…</span>
          </button>
        )}
      </div>
    </Popover>
  );
}
