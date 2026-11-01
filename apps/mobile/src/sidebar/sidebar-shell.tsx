import type { WorkspaceSurfaceDestination } from "@opensteer/client/host";
import { CommonActions, StackActions, type NavigationAction } from "@react-navigation/native";
import { isRecord } from "@opensteer/shared/isRecord";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  BackHandler,
  I18nManager,
  Keyboard,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
  type HostInstance,
  type LayoutChangeEvent,
} from "react-native";
import ReanimatedDrawerLayout, {
  DrawerKeyboardDismissMode,
  DrawerLockMode,
  DrawerPosition,
  DrawerState,
  DrawerType,
  type DrawerLayoutMethods,
} from "react-native-gesture-handler/ReanimatedDrawerLayout";
import Animated from "react-native-reanimated";
import {
  ReservedRegionsProvider,
  useReservedRegions,
  useReservedRegionsReady,
} from "react-native-reserved-regions";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { paramsDestination, sameDestination, workspaceRoute } from "../browser/surface-route.js";
import { deriveShell, edgesAround, type SidebarArrangement, type Size } from "../layout.js";
import { color } from "../theme.js";
import { useHostUserId, useSelectedHostClient } from "../ui/mobile-client-context.js";
import { appear, exit } from "../ui/motion.js";
import { Pane } from "../ui/pane.js";
import type { ScrollMemory } from "../ui/retained-scroll.js";
import {
  SidebarControlContext,
  SidebarDockedContext,
  SidebarVisibleContext,
  type SidebarControl,
} from "./sidebar-context.js";
import {
  SidebarPanel,
  type ShelfMemory,
  type SidebarActions,
  type SidebarDestination,
} from "./sidebar-panel.js";

/**
 * The sidebar around the app's one native stack.
 *
 * It is the stack's own `layout`, so it wraps the navigator in place: there is
 * still exactly one navigator, one history and one `navigationRef`, and every
 * destination the sidebar offers is an ordinary route pushed over Chat. Native
 * sheets present above it, because UIKit presents them from the stack itself.
 *
 * Where the window has room, the sidebar docks as a column beside the stack,
 * whatever the stack shows, so a task, Chat or a tab is always one press from
 * another; there is no hiding it. Elsewhere it is Gesture Handler's Reanimated
 * drawer, whose drag and settle run on the UI thread and honour the system's
 * Reduce Motion setting. The shell measures its own surface and the regions
 * the system reserves in it — a fold, a camera — and decides which. Deciding
 * never navigates and never moves the stack in the tree, so folding and
 * unfolding keep every screen, draft, scroll position and stream exactly
 * where it was.
 *
 * The drawer can be dragged open only from Chat, Specialists, Tabs and
 * Schedules — the screens that carry the Menu and have no Back of their own —
 * so it never competes with a task's edge-swipe back or a sheet's gestures.
 */
/** The narrowest drawer worth opening: past a fold nearer than this it may cross it. */
const sidebarMinimumWidth = 260;

const destinations: ReadonlySet<string> = new Set<SidebarDestination>([
  "Home",
  "Schedules",
  "Specialists",
  "Tabs",
]);

/**
 * Each platform's own sidebar. iOS moves the screen aside to show what is
 * beside it, the way its conversation apps do, and dims what stays in view;
 * Android lays Material's modal drawer over the screen under a heavier scrim.
 */
const sidebarMotion =
  Platform.OS === "ios"
    ? { overlayColor: "rgba(0, 0, 0, 0.45)", type: DrawerType.SLIDE }
    : { overlayColor: "rgba(0, 0, 0, 0.62)", type: DrawerType.FRONT };

/** As much of the stack's state as the sidebar reads. */
interface StackView {
  readonly index: number;
  readonly routes: readonly {
    readonly key: string;
    readonly name: string;
    readonly params?: object | undefined;
  }[];
}

interface ShellProps {
  readonly children: ReactNode;
  readonly navigation: { readonly dispatch: (action: NavigationAction) => void };
  readonly state: StackView;
}

export function SidebarShell(props: ShellProps): ReactNode {
  // The shell's surface is this provider's view: the one place window geometry
  // is measured for the shell, in the coordinates its regions arrive in.
  const [bounds, setBounds] = useState<Size>({ height: 0, width: 0 });
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, width } = event.nativeEvent.layout;
    setBounds((current) =>
      current.height === height && current.width === width ? current : { height, width },
    );
  }, []);
  return (
    <ReservedRegionsProvider onLayout={onLayout} style={styles.fill}>
      <SidebarFrame bounds={bounds} navigation={props.navigation} state={props.state}>
        {props.children}
      </SidebarFrame>
    </ReservedRegionsProvider>
  );
}

function SidebarFrame(props: ShellProps & { readonly bounds: Size }): ReactNode {
  const drawer = useRef<DrawerLayoutMethods>(null);
  const regions = useReservedRegions();
  const ready = useReservedRegionsReady();
  const window = useWindowDimensions();
  // The shell surface's own safe area: a conversation is judged on the room it
  // has once the notch or bar at its edge is taken out.
  const insets = useSafeAreaInsets();
  // Where the reader had scrolled the task list. The drawer and the docked
  // column are different views of it, and the shell outlives both, so a fold
  // that swaps one for the other returns the list where it was.
  const scrollMemory = useRef<ScrollMemory>({ offset: 0 }).current;
  const shelfMemory = useRef<ShelfMemory>({ list: null }).current;
  const { fontScale } = window;
  const rtl = I18nManager.isRTL;
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const trigger = useRef<HostInstance | null>(null);
  const restoreFocus = useRef(false);
  const latest = useRef(props.state);
  useLayoutEffect(() => {
    latest.current = props.state;
  });

  const base = props.state.routes[0];
  const deploymentId =
    base?.name === "Home" &&
    isRecord(base.params) &&
    typeof base.params["deploymentId"] === "string"
      ? base.params["deploymentId"]
      : null;
  const focused = props.state.routes[props.state.index];
  const destination =
    deploymentId !== null && focused !== undefined && destinations.has(focused.name)
      ? (focused.name as SidebarDestination)
      : null;
  const focusedParams = isRecord(focused?.params) ? focused.params : null;
  const selectedThreadId =
    focused?.name === "Thread" && typeof focusedParams?.["threadId"] === "string"
      ? focusedParams["threadId"]
      : null;
  // The exact tab, app or phone in front, as its route names it; held while
  // the route's params are, so the panel is not redrawn for the same one.
  const pageParams = focused?.name === "WorkspaceBrowser" ? focused.params : undefined;
  const selectedPlace = useMemo(() => paramsDestination(pageParams), [pageParams]);
  // One page or app in front with its own conversation: the pair arranges
  // itself around the folds it can use. A tab from Tabs stands alone.
  const aroundFolds =
    selectedPlace !== null &&
    focusedParams?.["scope"] === undefined &&
    typeof focusedParams?.["threadId"] === "string";
  // The task whose conversation is on screen, alone or beside its page.
  const pageThreadId =
    aroundFolds && typeof focusedParams?.["threadId"] === "string"
      ? focusedParams["threadId"]
      : null;
  const openThreadId = selectedThreadId ?? pageThreadId;

  // The arrangement last drawn, held across renders so a width hovering on
  // the threshold does not flip it.
  const previous = useRef<SidebarArrangement>({ mode: "drawer" });
  const shell = deriveShell({
    aroundFolds,
    bounds: props.bounds,
    fontScale,
    insets,
    previous: previous.current,
    ready,
    regions,
    rtl,
  });
  useLayoutEffect(() => {
    previous.current = shell.sidebar;
  });
  const column = shell.sidebar.mode === "column" ? shell.sidebar : null;
  const measured = props.bounds.width > 0 && props.bounds.height > 0;
  const contentEdges = edgesAround(props.bounds, shell.content, rtl);
  const sidebarEdges =
    shell.sidebarRect === null ? null : edgesAround(props.bounds, shell.sidebarRect, rtl);
  // The stack keeps to its own span: after the column, or alone on the larger
  // side of any fold it is not beside. Margins, not a new parent, so the stack
  // keeps its place in the tree.
  const contentPlace = measured
    ? {
        flex: 0,
        marginBottom: contentEdges.bottom,
        marginStart:
          contentEdges.start -
          (sidebarEdges === null ? 0 : sidebarEdges.start + (column?.width ?? 0)),
        marginTop: contentEdges.top,
        width: shell.content.width,
      }
    : styles.fill;
  const geometry = `${shell.sidebar.mode}:${shell.content.x},${shell.content.y},${shell.content.width},${shell.content.height}`;
  const docked = column !== null;
  const dockedRef = useRef(docked);
  dockedRef.current = docked;

  const close = useCallback(() => drawer.current?.closeDrawer(), []);
  const open = useCallback((from?: HostInstance | null) => {
    // Docked, the sidebar is already beside the screen: the keyboard and the
    // draft's focus stay where they are.
    if (dockedRef.current) return;
    // The keyboard would otherwise stay up over the drawer. The draft is the
    // composer's and is untouched; only the field loses focus.
    Keyboard.dismiss();
    trigger.current = from ?? null;
    restoreFocus.current = true;
    drawer.current?.openDrawer();
  }, []);
  const control = useMemo<SidebarControl>(() => ({ close, open }), [close, open]);

  const onDrawerStateChanged = useCallback((state: DrawerState, willShow: boolean) => {
    // A drag reports `willShow` as false while it is still deciding, so any
    // movement counts as covering the screen until the drawer settles.
    const next = state === DrawerState.IDLE ? willShow : true;
    if (visibleRef.current === next) return;
    visibleRef.current = next;
    setVisible(next);
    if (next) return;
    const from = trigger.current;
    trigger.current = null;
    if (restoreFocus.current && from !== null)
      AccessibilityInfo.sendAccessibilityEvent(from, "focus");
  }, []);

  // Anything that changes what is underneath — a destination, a link, a sheet,
  // another Deployment, the Host attachment being released or replaced, or a
  // different person signed in to the same one — takes the drawer away with
  // it. Sign-out keeps the route, so the route alone would not say so. So does
  // the window docking the sidebar: the column replaces the drawer.
  const focusedKey = focused?.key ?? null;
  const hostClient = useSelectedHostClient();
  const readerId = useHostUserId(hostClient);
  useEffect(() => {
    if (visibleRef.current) drawer.current?.closeDrawer();
  }, [deploymentId, docked, focusedKey, hostClient, readerId]);
  // Another Deployment's list starts at its top.
  useEffect(() => {
    scrollMemory.offset = 0;
    shelfMemory.list = null;
  }, [deploymentId, scrollMemory, shelfMemory]);

  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      drawer.current?.closeDrawer();
      return true;
    });
    return () => subscription.remove();
  }, [visible]);

  const leave = useCallback(() => {
    restoreFocus.current = false;
    drawer.current?.closeDrawer();
  }, []);

  const actions = useMemo<SidebarActions>(() => {
    const navigation = props.navigation;
    /**
     * Goes to a place the sidebar offers. From Chat, Specialists or Tabs — the
     * only screens the drawer opens over — a task or tab is pushed, so Back
     * returns there. A docked sidebar is beside every screen, so from anywhere
     * else the choice returns to Chat's level first: Chat's own route stays,
     * so the mounted Chat keeps its draft and scroll, and the stack never
     * grows by moving around the sidebar. The rule does not depend on the
     * window's shape.
     */
    const go = (name: string, params: object, replaceDestination: boolean): void => {
      const state = latest.current;
      const home = state.routes[0];
      const current = state.routes[state.index];
      if (home === undefined || home.name !== "Home") return;
      if (current === undefined || state.index === 0) {
        navigation.dispatch(StackActions.push(name, params));
        return;
      }
      if (destinations.has(current.name)) {
        navigation.dispatch(
          replaceDestination ? StackActions.replace(name, params) : StackActions.push(name, params),
        );
        return;
      }
      const reset = CommonActions.reset({ index: 1, routes: [home, { name, params }] });
      navigation.dispatch({ payload: reset.payload ?? {}, type: reset.type });
    };
    const show = (target: SidebarDestination): void => {
      leave();
      const state = latest.current;
      const home = state.routes[0];
      if (home === undefined || home.name !== "Home" || !isRecord(home.params)) return;
      if (target === "Home") {
        if (state.index > 0) navigation.dispatch(StackActions.popToTop());
        return;
      }
      const current = state.routes[state.index];
      if (current?.name === target) return;
      // Chat stays mounted underneath, untouched, so its transcript, scroll
      // position and draft are exactly where they were. One destination
      // replaces another in place. Tabs is the Deployment's, never the
      // conversation that happened to be in front.
      go(target, { deploymentId: home.params["deploymentId"] }, true);
    };
    return {
      close,
      onChat: () => show("Home"),
      onOpenPlace: (destination: WorkspaceSurfaceDestination) => {
        leave();
        const state = latest.current;
        const home = state.routes[0];
        const current = state.routes[state.index];
        if (home === undefined || !isRecord(home.params)) return;
        const targetDeploymentId = home.params["deploymentId"];
        if (typeof targetDeploymentId !== "string") return;
        if (
          current?.name === "WorkspaceBrowser" &&
          isRecord(current.params) &&
          current.params["scope"] === "workspace" &&
          current.params["deploymentId"] === targetDeploymentId &&
          sameDestination(paramsDestination(current.params), destination)
        )
          return;
        // Exactly the tab, alone: who opened it, or who is in front, is not
        // whom it talks to.
        go("WorkspaceBrowser", workspaceRoute(targetDeploymentId, destination), false);
      },
      onNewTask: (targetDeploymentId, workspaceId) => {
        leave();
        go("NewTask", { deploymentId: targetDeploymentId, workspaceId }, false);
      },
      onOpenTask: (targetDeploymentId, threadId) => {
        leave();
        const state = latest.current;
        const current = state.routes[state.index];
        if (
          current?.name === "Thread" &&
          isRecord(current.params) &&
          current.params["threadId"] === threadId &&
          current.params["deploymentId"] === targetDeploymentId
        )
          return;
        go("Thread", { deploymentId: targetDeploymentId, threadId }, false);
      },
      onSearch: (targetDeploymentId) => {
        leave();
        go("TaskSearch", { deploymentId: targetDeploymentId }, false);
      },
      onSettings: () => {
        leave();
        navigation.dispatch(StackActions.push("Settings"));
      },
      onSchedules: () => show("Schedules"),
      onSpecialists: () => show("Specialists"),
      onTabs: () => show("Tabs"),
    };
  }, [close, leave, props.navigation]);

  return (
    <SidebarControlContext.Provider value={control}>
      <SidebarDockedContext.Provider value={docked}>
        <SidebarVisibleContext.Provider value={visible}>
          <ReanimatedDrawerLayout
            drawerBackgroundColor="transparent"
            drawerLockMode={
              destination === null || docked
                ? DrawerLockMode.LOCKED_CLOSED
                : DrawerLockMode.UNLOCKED
            }
            drawerPosition={DrawerPosition.LEFT}
            drawerType={sidebarMotion.type}
            drawerWidth={Math.max(
              0,
              Math.min(
                (measured ? props.bounds.width : window.width) - 56,
                340,
                // Opened from the leading edge, the drawer stops at a fold
                // rather than lying across it, unless that leaves no list at all.
                measured && shell.leadingRoom >= sidebarMinimumWidth ? shell.leadingRoom : 340,
              ),
            )}
            edgeWidth={28}
            keyboardDismissMode={DrawerKeyboardDismissMode.ON_DRAG}
            onDrawerStateChanged={onDrawerStateChanged}
            overlayColor={sidebarMotion.overlayColor}
            ref={drawer}
            renderNavigationView={() =>
              docked ? null : (
                <SidebarPanel
                  actions={actions}
                  deploymentId={deploymentId}
                  destination={destination}
                  docked={false}
                  scroll={scrollMemory}
                  shelves={shelfMemory}
                  selectedPlace={selectedPlace}
                  selectedThreadId={selectedThreadId}
                  openThreadId={openThreadId}
                  visible={visible}
                />
              )
            }
          >
            {/* The children keep their place in this row whatever the window
                does: the column and its gap come and go before them. */}
            <View style={styles.row}>
              {column === null ? null : (
                <Animated.View
                  entering={appear}
                  exiting={exit}
                  style={[
                    styles.column,
                    {
                      marginBottom: sidebarEdges?.bottom ?? 0,
                      marginStart: sidebarEdges?.start ?? 0,
                      marginTop: sidebarEdges?.top ?? 0,
                      width: column.width,
                    },
                  ]}
                >
                  <Pane
                    clearance={shell.sidebarClearance}
                    style={styles.fill}
                    testID="sidebar-column"
                  >
                    <SidebarPanel
                      actions={actions}
                      deploymentId={deploymentId}
                      destination={destination}
                      docked
                      scroll={scrollMemory}
                      shelves={shelfMemory}
                      selectedPlace={selectedPlace}
                      selectedThreadId={selectedThreadId}
                      openThreadId={openThreadId}
                      visible
                    />
                  </Pane>
                </Animated.View>
              )}
              <Pane
                clearance={shell.contentClearance}
                geometry={geometry}
                style={contentPlace}
                testID="stack-column"
              >
                {props.children}
              </Pane>
            </View>
          </ReanimatedDrawerLayout>
        </SidebarVisibleContext.Provider>
      </SidebarDockedContext.Provider>
    </SidebarControlContext.Provider>
  );
}

const styles = StyleSheet.create({
  // The seam between the list and what it opens is one hairline, at the
  // strength the rest of the app frames a surface with.
  column: {
    backgroundColor: color.background,
    borderColor: color.lineStrong,
    borderEndWidth: StyleSheet.hairlineWidth,
  },
  fill: { flex: 1 },
  row: { backgroundColor: color.background, flex: 1, flexDirection: "row" },
});
