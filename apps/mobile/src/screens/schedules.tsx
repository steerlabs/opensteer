import {
  schedulesClient,
  sectionAutomations,
  type HostClient,
  type HostSnapshot,
  type ScheduleState,
} from "@opensteer/client/host";
import { useHostSelector, useSchedules } from "@opensteer/client/react";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { headerActions } from "../navigation-header.js";
import { color, space } from "../theme.js";
import { useAppForeground } from "../ui/foreground.js";
import { Notice } from "../ui/primitives.js";
import { Screen } from "../ui/screen.js";
import { AutomationList } from "./automation-list.js";
import { automationRow } from "./automation-row.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type SchedulesScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Automations: everything set to run on this Deployment on its own, from the
 * sidebar like Tabs, in the web's groups — what needs you, what comes up,
 * what repeats, what waits for an event, what is paused, and Opensteer's own
 * upkeep. A row opens the automation; its thread is one tap from there.
 *
 * It reads only while it is in front: the list is a Host read this screen
 * asks for, never part of attaching, and a screen covered by another releases
 * it.
 */
export function SchedulesScreen(props: SchedulesScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const hostClient = useAttachedHost(deploymentId);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return <SchedulesForHost deploymentId={deploymentId} hostClient={hostClient} />;
}

const selectReader = (snapshot: HostSnapshot) =>
  snapshot.session === "authenticated" ? (snapshot.user?.id ?? null) : null;

/** Nothing one person was shown is ever shown to another: each reader starts afresh. */
function SchedulesForHost(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const reader = useHostSelector(props.hostClient, selectReader);
  if (reader === null) {
    return (
      <Screen>
        <Notice
          detail="Your automations appear once you are signed in."
          title="Connecting…"
          tone="neutral"
        />
      </Screen>
    );
  }
  return <ScheduleList key={reader} {...props} />;
}

/**
 * What a schedule screen shows of the Host's answer. A re-read — after any
 * schedule changes, or a run starts or ends — keeps the last answer in view
 * rather than blanking to a spinner, and so does losing the connection, where
 * the screen says it is offline and offers nothing that would change the Host.
 * A refusal or a failure replaces it: what it showed can no longer be vouched
 * for. Only ever Host answers for this reader, since each reader remounts.
 */
export function useShownSchedule<T>(state: ScheduleState<T>): T | null {
  const held = useRef<T | null>(null);
  if (state.status === "ready") held.current = state.data;
  else if (state.status === "error" || state.status === "unavailable") held.current = null;
  return state.status === "ready" ? state.data : held.current;
}

/** The read the Host refused or failed, as one notice with the way on from it. */
export function ScheduleProblem(props: {
  readonly onRetry: () => void;
  readonly state: ScheduleState<unknown>;
}): ReactNode {
  const { state } = props;
  if (state.status === "unavailable") {
    return (
      <Notice
        detail="This Host doesn’t offer automations. Update Opensteer on the computer it runs on to see them here."
        title="Automations aren’t available here"
        tone="neutral"
      />
    );
  }
  if (state.status === "offline") {
    return <Notice detail={state.error ?? ""} title="Offline" tone="neutral" />;
  }
  return (
    <Notice
      action={{ label: "Try again", onPress: props.onRetry }}
      detail={state.error ?? "Automations could not be loaded."}
      title="Automations didn’t load"
    />
  );
}

/** The most `triggers.list` answers with; a full answer may not be all of them. */
const hostListCap = 100;

/** The time to the minute while the screen is in front, so "in 4 min" stays true. */
function useMinute(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    let interval: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(
      () => {
        setNow(Date.now());
        interval = setInterval(() => setNow(Date.now()), 60_000);
      },
      60_000 - (Date.now() % 60_000),
    );
    return () => {
      clearTimeout(start);
      if (interval !== undefined) clearInterval(interval);
    };
  }, [active]);
  return now;
}

function ScheduleList(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}): ReactNode {
  const { deploymentId, hostClient } = props;
  const navigation = useNavigation();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const state = useSchedules(hostClient, undefined, focused && foreground);
  const items = useShownSchedule(state);
  const now = useMinute(focused && foreground);

  useLayoutEffect(() => {
    navigation.setOptions(
      headerActions({
        right: {
          accessibilityHint: "Opens Home, where you ask your agent for one",
          icon: "plus",
          label: "New",
          onPress: () => navigation.dispatch(StackActions.popToTop()),
        },
      }),
    );
  }, [navigation]);

  // A failed re-read is the resource's state; the screen shows it from there.
  const reload = useCallback(
    () =>
      schedulesClient(hostClient)
        .list.refresh()
        .catch(() => undefined),
    [hostClient],
  );
  const open = useCallback(
    (triggerId: string) =>
      navigation.dispatch(StackActions.push("Schedule", { deploymentId, triggerId })),
    [deploymentId, navigation],
  );
  const sections = useMemo(
    () =>
      items === null
        ? []
        : sectionAutomations(items, now).map((section) => ({
            id: section.id,
            rows: section.items.map(({ item, problem }) => automationRow(item, problem, now)),
            title: section.title,
          })),
    [items, now],
  );

  if (items === null) {
    return (
      <Screen>
        {state.status === "loading" ? (
          <View accessibilityLabel="Loading automations" style={styles.loading}>
            <ActivityIndicator color={color.muted} />
          </View>
        ) : (
          <ScheduleProblem onRetry={() => void reload()} state={state} />
        )}
      </Screen>
    );
  }
  return (
    <AutomationList
      banner={
        state.status === "offline" ? (
          <ScheduleProblem onRetry={() => void reload()} state={state} />
        ) : null
      }
      capped={items.length >= hostListCap}
      onOpen={open}
      onRefresh={reload}
      sections={sections}
    />
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", paddingVertical: space[48] },
});
