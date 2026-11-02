import {
  HostClientRequestError,
  startPageIndex,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type StartPageGroup,
  type WorkspaceSurfaceDestination,
} from "@opensteer/client/host";
import { computerNotReadyStatus, computerReasonWords } from "@opensteer/client/integrations";
import { useHostSelector, usePlaceList } from "@opensteer/client/react";
import type { ApprovedComputerApp, ComputerViewTarget, OwnerWindowInfo } from "@opensteer/protocol";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, SectionList, StyleSheet, View } from "react-native";
import { workspaceRoute } from "../browser/surface-route.js";
import { operationDetail } from "../client/mobile-client.js";
import { MacAppIcon } from "../computers/app-mark.js";
import { openOwnerView } from "../computers/open-owner-view.js";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { useMobileState } from "../ui/mobile-client-context.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText, Notice, StatusDot } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

export type OpenAppScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/**
 * Open: the person's own Mac apps and Agent Phones, from the phone, the way
 * the new-tab page offers them on a computer. Each Mac lists the apps it lets
 * Opensteer use, by their own icons, and how many windows each has open. A
 * choice opens the person's own view of exactly that app or window over the
 * screen this sheet came from; one already open is switched to, never opened
 * twice. Approving an app stays on its Mac.
 */
export function OpenAppScreen(props: OpenAppScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) return null;
  return <OpenApp deploymentId={deploymentId} hostClient={selection.hostClient} />;
}

type Approved =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "ready"; readonly apps: readonly ApprovedComputerApp[] };

/** An app's windows as its Mac last said, or null while unknown or unreadable. */
type Windows = ReadonlyMap<string, readonly OwnerWindowInfo[] | null>;

interface Section {
  readonly key: string;
  readonly group: StartPageGroup;
  readonly data: readonly ApprovedComputerApp[];
}

const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;
const selectConnected = (snapshot: HostSnapshot) => snapshot.connection === "connected";

function OpenApp(props: { readonly deploymentId: string; readonly hostClient: HostClient }) {
  const { deploymentId, hostClient } = props;
  const navigation = useNavigation();
  const insets = useContentInsets();
  const machines = useHostSelector(hostClient, selectMachines);
  const connected = useHostSelector(hostClient, selectConnected);
  const places = usePlaceList(hostClient);
  const [approved, setApproved] = useState<Approved>({ kind: "loading" });
  const [windows, setWindows] = useState<Windows>(new Map());
  const [opening, setOpening] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    setApproved({ kind: "loading" });
    void hostClient.listApprovedComputerApps().then(
      (apps) => {
        if (mounted.current) setApproved({ kind: "ready", apps });
      },
      (error: unknown) => {
        if (mounted.current)
          setApproved({
            kind: "failed",
            detail: operationDetail(error, "Your apps could not be listed."),
          });
      },
    );
  }, [hostClient]);
  useEffect(load, [load]);

  // Regrouped as the computers change; a streamed reply leaves them, and this, alone.
  const groups = useMemo(
    () =>
      approved.kind === "ready"
        ? startPageIndex({
            snapshot: { ...hostClient.getSnapshot(), machines },
            approvedApps: approved.apps,
            places: [],
          }).groups
        : [],
    [approved, hostClient, machines],
  );

  // Each ready Mac app's windows, asked once per listing, all at once.
  useEffect(() => {
    let current = true;
    const apps = groups.flatMap((group) =>
      group.kind === "apps" && group.readiness === null ? group.items : [],
    );
    for (const app of apps) {
      if (app.target.kind !== "app") continue;
      void hostClient.listComputerAppWindows(app.machineId, app.target.app).then(
        (list) => {
          if (current) setWindows((held) => new Map(held).set(app.connectionId, list));
        },
        () => {
          if (current) setWindows((held) => new Map(held).set(app.connectionId, null));
        },
      );
    }
    return () => {
      current = false;
    };
  }, [groups, hostClient]);

  const sections = useMemo(
    (): readonly Section[] =>
      groups.map((group) => ({
        key: `${group.kind}:${group.machineId}`,
        group,
        data: group.items,
      })),
    [groups],
  );

  const show = useCallback(
    (destination: WorkspaceSurfaceDestination) => {
      // The sheet goes first, so the view opens over the screen it came from.
      navigation.goBack();
      navigation.dispatch(
        StackActions.push("WorkspaceBrowser", workspaceRoute(deploymentId, destination)),
      );
    },
    [deploymentId, navigation],
  );

  const openApp = useCallback(
    async (app: ApprovedComputerApp, target: ComputerViewTarget, key: string) => {
      const held = heldView(places, app, target);
      if (held !== null) {
        show(held.destination);
        return;
      }
      setOpening(key);
      setFailure(null);
      try {
        const destination = await openOwnerView(
          hostClient,
          app.machineId,
          target,
          () =>
            mounted.current &&
            navigation.isFocused() &&
            hostClient.getSnapshot().deploymentId === deploymentId,
        );
        if (destination !== null) show(destination);
      } catch (error) {
        if (!mounted.current) return;
        const machine = hostClient.getSnapshot().machines.find(({ id }) => id === app.machineId);
        setFailure(
          error instanceof HostClientRequestError && error.reason !== undefined
            ? computerReasonWords(error.reason, {
                machine: machine?.name ?? "This computer",
                phone: app.target.kind === "phone",
                target: app.name,
              })
            : operationDetail(error, `${app.name} didn’t open.`),
        );
      } finally {
        if (mounted.current) setOpening(null);
      }
    },
    [deploymentId, hostClient, navigation, places, show],
  );
  const open = useCallback(
    (app: ApprovedComputerApp, target: ComputerViewTarget, key: string) =>
      void openApp(app, target, key),
    [openApp],
  );

  const renderItem = useCallback(
    ({ index, item, section }: { index: number; item: ApprovedComputerApp; section: Section }) => (
      <AppRow
        app={item}
        disabled={!connected || section.group.readiness !== null || opening !== null}
        first={index === 0}
        hostClient={hostClient}
        last={index === section.data.length - 1}
        onOpen={open}
        openWindows={openWindows(places, item, windows.get(item.connectionId))}
        opening={opening}
        windows={windows.get(item.connectionId)}
      />
    ),
    [connected, hostClient, open, opening, places, windows],
  );

  return (
    <View style={styles.sheet}>
      <View accessibilityRole="header" style={styles.head}>
        <AppText role="title">Open</AppText>
      </View>
      <SectionList<ApprovedComputerApp, Section>
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space[16] }]}
        keyExtractor={(app) => app.connectionId}
        ListEmptyComponent={
          approved.kind === "loading" ? (
            <View accessibilityLabel="Finding your apps" style={styles.empty}>
              <ActivityIndicator color={color.muted} />
            </View>
          ) : approved.kind === "failed" ? (
            <Notice
              action={{ label: "Try again", onPress: load }}
              detail={approved.detail}
              title="Your apps could not be listed"
            />
          ) : (
            <View style={styles.empty}>
              <View style={styles.emptyGlyph}>
                <Symbol name="laptopcomputer" size={22} tint={color.muted} />
              </View>
              <AppText role="bodyMedium">No apps to open yet</AppText>
              <AppText role="secondary" style={styles.centred} tone="muted">
                On your Mac, choose the apps Opensteer may use. They appear here to open from your
                phone.
              </AppText>
            </View>
          )
        }
        ListHeaderComponent={
          failure === null ? undefined : (
            <View style={styles.notice}>
              <Notice detail={failure} title="That didn’t open" />
            </View>
          )
        }
        renderItem={renderItem}
        renderSectionHeader={({ section }) => <GroupHead group={section.group} />}
        sections={sections}
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}

/**
 * The person's own open view of exactly this target, if one is live: a phone's
 * screen, or a Mac app's view of the very window named. An app open naming no
 * window is the Host's to resolve to the front window, so it never matches
 * here; nor does a task's hold on the app.
 */
function heldView(
  places: readonly PlaceItem[],
  app: ApprovedComputerApp,
  target: ComputerViewTarget,
): PlaceItem | null {
  return (
    places.find((place) => {
      const view = place.ownerView;
      if (view === null || view.machineId !== app.machineId || view.state === "closed")
        return false;
      if (target.kind === "phone") return view.target.kind === "phone";
      if (view.target.kind !== "app") return false;
      if (view.target.app.bundleId.toLowerCase() !== target.app.bundleId.toLowerCase())
        return false;
      return target.window !== undefined && view.window?.id === target.window;
    }) ?? null
  );
}

/**
 * What a row opens with a tap: a phone's screen, or a Mac app's only window
 * when the Mac has said which it is; otherwise the app, for the Host to resolve.
 */
function rowTarget(
  app: ApprovedComputerApp,
  windows: readonly OwnerWindowInfo[] | null | undefined,
): ComputerViewTarget {
  return app.target.kind === "app" && windows?.length === 1
    ? { ...app.target, window: windows[0]!.id }
    : app.target;
}

/** The ids of this app's windows (or the phone's screen, as 0) the person already has open. */
function openWindows(
  places: readonly PlaceItem[],
  app: ApprovedComputerApp,
  windows: readonly OwnerWindowInfo[] | null | undefined,
): readonly number[] {
  if (app.target.kind === "phone") return heldView(places, app, app.target) ? [0] : [];
  const target = app.target;
  return (windows ?? []).flatMap((window) =>
    heldView(places, app, { ...target, window: window.id }) ? [window.id] : [],
  );
}

/** A computer's name over its apps, with why it can't open them when it can't. */
function GroupHead(props: { readonly group: StartPageGroup }): ReactNode {
  const { group } = props;
  const status = group.readiness === null ? null : computerNotReadyStatus(group.readiness);
  const title = group.kind === "phone" ? `Agent Phone · ${group.label}` : group.label;
  return (
    <View
      accessibilityLabel={status === null ? title : `${title}, ${status.label}`}
      accessibilityRole="header"
      style={styles.groupHead}
    >
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        style={styles.groupTitle}
        tone="muted"
      >
        {title}
      </AppText>
      {status === null ? null : (
        <View style={styles.groupStatus}>
          <StatusDot size={6} tone={status.tone === "attention" ? "amber" : "muted"} />
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="muted">
            {status.label}
          </AppText>
        </View>
      )}
    </View>
  );
}

/** What a row says under the app's name: its windows, or that it's already open. */
function windowWords(
  windows: readonly OwnerWindowInfo[] | null | undefined,
  open: boolean,
): string | null {
  if (open) return "Open";
  if (windows === undefined || windows === null) return null;
  if (windows.length === 0) return "No windows open";
  if (windows.length === 1) return windows[0]!.title || "1 window";
  return `${windows.length} windows`;
}

const AppRow = memo(function AppRow(props: {
  readonly app: ApprovedComputerApp;
  readonly disabled: boolean;
  readonly first: boolean;
  readonly hostClient: HostClient;
  readonly last: boolean;
  readonly onOpen: (app: ApprovedComputerApp, target: ComputerViewTarget, key: string) => void;
  /** Windows already open as the person's own views; a single-window row is open when its is. */
  readonly openWindows: readonly number[];
  readonly opening: string | null;
  readonly windows: readonly OwnerWindowInfo[] | null | undefined;
}): ReactNode {
  const { app, windows } = props;
  const busy = props.opening !== null && props.opening.startsWith(app.connectionId);
  const tapTarget = rowTarget(app, windows);
  const open =
    tapTarget.kind === "phone"
      ? props.openWindows.length > 0
      : tapTarget.window !== undefined && props.openWindows.includes(tapTarget.window);
  const detail = app.target.kind === "phone" ? "Screen" : windowWords(windows, open);
  const style = ({ pressed }: { readonly pressed: boolean }) => [
    styles.row,
    props.first && styles.rowFirst,
    props.last && styles.rowLast,
    !props.first && styles.rowSeparated,
    pressed && !props.disabled && styles.pressed,
  ];
  const body = (
    <>
      {app.target.kind === "app" ? (
        <MacAppIcon
          app={app.target.app}
          blocked={props.disabled && !busy}
          hostClient={props.hostClient}
          machineId={app.machineId}
        />
      ) : (
        <View style={[styles.glyph, props.disabled && !busy && styles.dimmed]}>
          <Symbol name="smartphone" size={17} tint={color.muted} />
        </View>
      )}
      <View style={styles.words}>
        <AppText
          numberOfLines={1}
          role="bodyMedium"
          tone={props.disabled && !busy ? "muted" : "default"}
        >
          {app.name}
        </AppText>
        {detail === null ? null : (
          <AppText numberOfLines={1} role="caption" tone="muted">
            {detail}
          </AppText>
        )}
      </View>
      {busy ? (
        <ActivityIndicator color={color.muted} />
      ) : open ? (
        <StatusDot size={8} tone="green" />
      ) : (
        <Symbol name="chevron.right" size={13} tint={color.muted} weight="semibold" />
      )}
    </>
  );
  const target = app.target;
  // Several windows: the Mac's own list of them, as a native menu on the row.
  if (target.kind === "app" && windows !== undefined && windows !== null && windows.length > 1)
    return (
      <NativeMenu
        accessibilityHint="Choose a window to open"
        accessibilityLabel={`${app.name}, ${windows.length} windows`}
        disabledReason={props.disabled ? `${app.name} can’t be opened right now.` : null}
        onPresent={noop}
        onSettle={noop}
        options={windows.map((window) => ({
          id: String(window.id),
          label: window.title || "Untitled window",
          selected: props.openWindows.includes(window.id),
          onPress: () =>
            props.onOpen(app, { ...target, window: window.id }, `${app.connectionId}:${window.id}`),
        }))}
        style={styles.menu}
        title={app.name}
      >
        {/* The menu wraps its trigger in a plain view, so the row draws its own line. */}
        <View style={style({ pressed: false })}>{body}</View>
      </NativeMenu>
    );
  return (
    <Pressable
      accessibilityHint={open ? `Shows ${app.name}` : `Opens ${app.name} on this phone`}
      accessibilityLabel={detail === null ? app.name : `${app.name}, ${detail}`}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onOpen(app, tapTarget, app.connectionId)}
      style={style}
    >
      {body}
    </Pressable>
  );
});

function noop(): void {}

const styles = StyleSheet.create({
  centred: { textAlign: "center" },
  dimmed: { opacity: 0.45 },
  empty: {
    alignItems: "center",
    gap: space[8],
    paddingHorizontal: space[16],
    paddingVertical: space[40],
  },
  emptyGlyph: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.lg,
    height: 48,
    justifyContent: "center",
    marginBottom: space[4],
    width: 48,
  },
  glyph: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  groupHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    paddingBottom: space[6],
    paddingHorizontal: space[4],
    paddingTop: space[16],
  },
  groupStatus: { alignItems: "center", flexDirection: "row", gap: space[4] },
  groupTitle: { flexShrink: 1, fontWeight: "600" },
  head: { paddingBottom: space[4], paddingHorizontal: space[20], paddingTop: space[20] },
  list: { paddingHorizontal: space[16] },
  menu: { alignSelf: "stretch" },
  notice: { paddingTop: space[8] },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    backgroundColor: color.surface,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[16],
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  rowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  rowSeparated: { borderColor: color.line, borderTopWidth: StyleSheet.hairlineWidth },
  sheet: { backgroundColor: color.surfaceElevated, flex: 1 },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
