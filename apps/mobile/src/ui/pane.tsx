import { createContext, useContext, useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { noInsets, type EdgeInsets } from "../layout.js";

const ClearanceContext = createContext<EdgeInsets>(noInsets);
const GeometryContext = createContext("");
const InViewContext = createContext(true);

/**
 * One pane of a layout surface: a sidebar column, the stack beside it, a page
 * or its conversation, or a presented sheet.
 *
 * Its safe area is its own native view's, measured by the platform where the
 * pane actually is, so a pane beside another one has no inset on the edge it
 * shares with it, a pane under the vertical bar has one, and a sheet has the
 * insets of where it was presented rather than of the screen under it. What
 * the platform reserves inside a surface — a camera island, a short division —
 * is not in any safe area, so the surface that measured it hands each pane the
 * clearance its own edges need.
 */
export function Pane(props: {
  readonly children: ReactNode;
  /** Obstructions over this pane, as edge distances. A nested pane replaces its parent's. */
  readonly clearance?: EdgeInsets;
  /**
   * Where the surface placed this pane, as a key that changes whenever the
   * arrangement does. It joins its parent's, so a pane nested in a pane hears
   * either surface rearranging.
   */
  readonly geometry?: string;
  /**
   * Kept mounted out of view while its screen is in front, as a page's
   * companion is in a window too narrow for two. Its surface hides it; this
   * tells what is inside, and every pane nested in it, that nobody sees it.
   */
  readonly hidden?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}): ReactNode {
  // Held by value: every content inset in the pane reads this, so a new object
  // with the same edges — each time the surface re-renders — must not reach them.
  const { bottom, left, right, top } = props.clearance ?? noInsets;
  const clearance = useMemo(() => ({ bottom, left, right, top }), [bottom, left, right, top]);
  const parent = useContext(GeometryContext);
  const geometry = props.geometry === undefined ? parent : `${parent}/${props.geometry}`;
  const inView = useContext(InViewContext) && props.hidden !== true;
  return (
    <SafeAreaProvider style={props.style} testID={props.testID}>
      <GeometryContext.Provider value={geometry}>
        <InViewContext.Provider value={inView}>
          <ClearanceContext.Provider value={clearance}>{props.children}</ClearanceContext.Provider>
        </InViewContext.Provider>
      </GeometryContext.Provider>
    </SafeAreaProvider>
  );
}

/**
 * Whether this pane is drawn where the reader can see it. A pane kept mounted
 * out of view is like a screen under another in the stack: it claims nothing,
 * marks nothing read and lets go of the keyboard and microphone, so what reads
 * navigation focus for that asks here as well.
 */
export function usePaneInView(): boolean {
  return useContext(InViewContext);
}

/**
 * How far this pane's content keeps from each edge: its own safe area, or the
 * clearance its surface measured over it, whichever is further.
 */
export function useContentInsets(): EdgeInsets {
  const safe = useSafeAreaInsets();
  const clearance = useContext(ClearanceContext);
  return useMemo(
    () => ({
      bottom: Math.max(safe.bottom, clearance.bottom),
      left: Math.max(safe.left, clearance.left),
      right: Math.max(safe.right, clearance.right),
      top: Math.max(safe.top, clearance.top),
    }),
    [clearance, safe.bottom, safe.left, safe.right, safe.top],
  );
}

/**
 * The arrangement this pane was placed by, as a key. A pane can move without
 * changing size — a sidebar or a vertical bar appearing, a posture change — and
 * anything aimed at where it was, such as a touch held on a remote picture,
 * must not survive that.
 */
export function usePaneGeometry(): string {
  return useContext(GeometryContext);
}

/**
 * A pane's content kept to its insets, for content that does not place its
 * own: a remote page, its address and dialogs. Scrolling content pads itself
 * so it can run under the insets and still end clear of them.
 */
export function InsetView(props: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}): ReactNode {
  const insets = useContentInsets();
  return (
    <View
      style={[
        props.style,
        {
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
          paddingTop: insets.top,
        },
      ]}
      testID={props.testID}
    >
      {props.children}
    </View>
  );
}
