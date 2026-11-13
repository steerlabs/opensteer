import { useNavigation, useRoute } from "@react-navigation/native";
import type { AccountDeploymentDirectoryUnavailable } from "@opensteer/client/connections";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Alert,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import {
  deploymentStatusDetail,
  deploymentStatusLabel,
  type DeploymentRow,
  type DeploymentStatus,
} from "../client/deployment-rows.js";
import { resetToDeployment, resetToDeployments } from "../navigation-ref.js";
import {
  color,
  controlFontScaleLimit,
  radius,
  space,
  touchTarget,
  deploymentPaint,
} from "../theme.js";
import {
  sameTaskListSource,
  taskList,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { UnreadDot } from "../threads/task-row.js";
import {
  attentionReads,
  computerBadge,
  type AttentionBadge,
  type ComputerAttention,
} from "./computer-signals.js";
import type { TeamSessionClient } from "@opensteer/client/team";
import { MentionCount, TeamTile } from "../team/team-marks.js";
import { useMobileTeams, useTeamsSnapshot } from "../team/team-context.js";
import {
  useMobileClient,
  useMobileState,
  useSelectedHostClient,
} from "../ui/mobile-client-context.js";
import { AppText, Notice, RowGroup, StatusDot } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { AccountIdentityRow } from "./add-deployment.js";
import {
  accountDirectoryUnavailablePresentation,
  accountIdentityLabel,
  accountFlowCanContinue,
  deploymentCanOpen,
  deploymentOpenLabel,
  deploymentsPresentation,
  eligibleSingletonDeployment,
  signedInDirectoryPresentation,
} from "./account-door.js";
import { deploymentInitial, deploymentTone, statusTone } from "./deployment-row.js";
import { deploymentRecoveryLabel, runDeploymentRecovery } from "./deployment-recovery.js";
import { DeploymentMenu } from "./deployment-menu.js";
import { phoneLeaves } from "./device-page-model.js";
import { useSetupScanner } from "./setup-scanner.js";
import { Welcome } from "./welcome.js";

const signedInStatuses: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "connected",
  "connecting",
  "offline",
  "reconnecting",
  "signed-in",
]);

const DeploymentListRow = memo(function DeploymentListRow(props: {
  /** This computer's one read when the list opened; undefined until it answers. */
  readonly attention: ComputerAttention | null | undefined;
  readonly current: boolean;
  readonly onDetails: (row: DeploymentRow) => void;
  readonly onOpen: (row: DeploymentRow) => void;
  readonly onPair: (row: DeploymentRow) => void;
  readonly onRemove: (row: DeploymentRow) => void;
  readonly onSignOut: (row: DeploymentRow) => void;
  readonly row: DeploymentRow;
}): ReactNode {
  const row = props.row;
  const detail = deploymentStatusDetail(row);
  const tone = deploymentPaint[deploymentTone(row.deploymentId)];
  const open = useCallback(() => props.onOpen(row), [props.onOpen, row]);
  const pair = useCallback(() => props.onPair(row), [props.onPair, row]);
  const details = useCallback(() => props.onDetails(row), [props.onDetails, row]);
  const remove = useCallback(() => props.onRemove(row), [props.onRemove, row]);
  const signOut = useCallback(() => props.onSignOut(row), [props.onSignOut, row]);
  const openable = deploymentCanOpen(row);

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityHint={
          openable
            ? "Opens this deployment and signs in when needed"
            : "Explains what must be fixed before this deployment can open"
        }
        accessibilityLabel={deploymentOpenLabel(row)}
        accessibilityRole="button"
        accessibilityState={{ selected: props.current }}
        onPress={open}
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
      >
        <View style={[styles.mark, { backgroundColor: tone.fill }]}>
          <AppText
            accessibilityLabel={`${row.name} mark`}
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="title"
            style={{ color: tone.ink }}
          >
            {deploymentInitial(row.name)}
          </AppText>
        </View>
        <View style={styles.copy}>
          <AppText numberOfLines={1} role="title">
            {row.name}
          </AppText>
          <View style={styles.statusLine}>
            <StatusDot
              live={row.status === "connecting" || row.status === "reconnecting"}
              tone={statusTone(row.status)}
            />
            <AppText role="caption" tone="muted">
              {deploymentStatusLabel(row.status)}
            </AppText>
            <AppText role="caption" tone="muted">
              ·
            </AppText>
            <AppText numberOfLines={1} role="caption" style={styles.kind} tone="muted">
              {row.kindLabel}
            </AppText>
          </View>
          {detail === null ? null : (
            <AppText numberOfLines={2} role="caption" tone="muted">
              {detail}
            </AppText>
          )}
          <ComputerSignals
            computerId={row.deploymentId}
            current={props.current}
            read={props.attention}
          />
        </View>
      </Pressable>
      {row.signIn === "pairing-code" ? (
        <Pressable
          accessibilityLabel={`${deploymentRecoveryLabel(row)} for ${row.name}`}
          accessibilityRole="button"
          onPress={pair}
          style={({ pressed }) => [styles.pair, pressed && styles.pressed]}
        >
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={2}
            role="caption"
            tone="ember"
          >
            {deploymentRecoveryLabel(row)}
          </AppText>
        </Pressable>
      ) : (
        <View style={styles.indicator}>
          <Symbol
            name={props.current ? "checkmark" : "chevron.right"}
            size={props.current ? 15 : 13}
            tint={props.current ? color.ember : color.mutedDim}
            weight="semibold"
          />
        </View>
      )}
      <DeploymentMenu
        canRemove={!row.accountManaged}
        canSignOut={signedInStatuses.has(row.status)}
        name={row.name}
        onDetails={details}
        onRemove={remove}
        onSignOut={signOut}
      />
    </View>
  );
});

/**
 * What a computer has waiting: its own Needs you count or unread dot, and each
 * team it is in with that team's mentions of the reader. The shown computer
 * speaks from its live snapshot; another from the one read made when the list
 * opened. Personal and work computers read alike, so the other is a glance away.
 */
function ComputerSignals(props: {
  readonly computerId: string;
  readonly current: boolean;
  readonly read: ComputerAttention | null | undefined;
}): ReactNode {
  const teams = useMobileTeams();
  useTeamsSnapshot();
  const joined = teams.teamsOn(props.computerId);
  const host = useSelectedHostClient();
  const shown = props.current && host !== null;
  const read = computerBadge({ current: false, shown: null, read: props.read });
  if (joined.length === 0 && !shown && read === null) return null;
  return (
    <View style={styles.signals}>
      {shown ? <ShownBadge host={host} /> : <Badge badge={read} />}
      {joined.map(({ team, session }) => (
        <TeamSignal key={team.teamId} name={team.teamName} session={session} teamId={team.teamId} />
      ))}
    </View>
  );
}

/** The shown computer's own attention, from the list it already holds: no request. */
function ShownBadge(props: { readonly host: HostClient }): ReactNode {
  const shown = useHostSelector(props.host, shownAttention, sameAttention);
  return <Badge badge={computerBadge({ current: true, shown, read: undefined })} />;
}

let shownHeld: { readonly source: HostSnapshot; readonly value: ComputerAttention } | null = null;
function shownAttention(snapshot: HostSnapshot): ComputerAttention {
  if (shownHeld !== null && sameTaskListSource(shownHeld.source, snapshot)) {
    const needsYou = snapshot.needsYou?.count ?? 0;
    if (needsYou === shownHeld.value.needsYou) return shownHeld.value;
  }
  const value = {
    needsYou: snapshot.needsYou?.count ?? 0,
    unread: taskList(snapshot).ready.some((row) => row.unread),
  };
  shownHeld = { source: snapshot, value };
  return value;
}

const sameAttention = (left: ComputerAttention, right: ComputerAttention): boolean =>
  left.needsYou === right.needsYou && left.unread === right.unread;

function Badge(props: { readonly badge: AttentionBadge }): ReactNode {
  const { badge } = props;
  if (badge === null) return null;
  if (badge.kind === "unread")
    return (
      <View accessibilityLabel="Unread results" style={styles.unreadMark}>
        <UnreadDot />
      </View>
    );
  return (
    <View
      accessibilityLabel={badge.count === 1 ? "1 task needs you" : `${badge.count} tasks need you`}
      style={styles.needsYou}
    >
      <Symbol name="exclamationmark.circle" size={11} tint={color.inkOnAmber} weight="bold" />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={styles.needsYouCount}
      >
        {String(badge.count)}
      </AppText>
    </View>
  );
}

/**
 * Each other computer's attention, asked once when the list opens (and again
 * only if the set of computers changes): one request each, in parallel, with a
 * short deadline and no retry.
 */
function useOtherComputersAttention(
  rows: readonly DeploymentRow[],
  shown: string | null,
): ReadonlyMap<string, ComputerAttention | null> {
  const client = useMobileClient();
  const [reads, setReads] = useState<ReadonlyMap<string, ComputerAttention | null>>(
    () => new Map(),
  );
  const asked = attentionReads(rows, shown).join(" ");
  useEffect(() => {
    let current = true;
    for (const id of asked === "" ? [] : asked.split(" "))
      void client.readAttention(id).then((attention) => {
        if (current) setReads((held) => new Map(held).set(id, attention));
      });
    return () => {
      current = false;
    };
  }, [asked, client]);
  return reads;
}

const TeamSignal = memo(function TeamSignal(props: {
  readonly name: string;
  readonly session: TeamSessionClient | null;
  readonly teamId: string;
}): ReactNode {
  const { session } = props;
  const mentions = useSyncExternalStore(
    useCallback(
      (listener: () => void) => session?.subscribe(listener) ?? (() => undefined),
      [session],
    ),
    useCallback(() => session?.getSnapshot().sidebar?.totalMentionCount ?? 0, [session]),
  );
  return (
    <View
      accessibilityLabel={
        mentions > 0
          ? `${props.name}, ${mentions} ${mentions === 1 ? "mention" : "mentions"}`
          : props.name
      }
      style={styles.teamSignal}
    >
      <TeamTile size={16} team={{ id: props.teamId, name: props.name, imageUri: null }} />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="caption"
        tone="soft"
      >
        {props.name}
      </AppText>
      <MentionCount count={mentions} />
    </View>
  );
});

/**
 * The catalog: every place this phone knows about, and what state it is in.
 *
 * The one memorable thing on the screen is the question on an empty list. With
 * deployments listed, the rows carry the weight and nothing competes with them:
 * a name, what kind of place it is, a status word with its dot, and the address.
 *
 * The rows sit inside one framed surface, hairline between each, exactly as the
 * web's directory does. The frame is what makes a stack of sentences read as a
 * list of places, and it is what gives a row a right-hand edge for what a row
 * can offer: the way in when it needs a sign-in, and the way to everything else
 * it can do.
 */
export function DeploymentsScreen(): ReactNode {
  const client = useMobileClient();
  const navigation = useNavigation();
  const route = useRoute();
  const { account, directory, rows, selection } = useMobileState();
  const enrolledIn = useIphoneAppsState(useIphoneApps()).snapshot.enrollment?.deploymentId ?? null;
  const attention = useOtherComputersAttention(rows, selection.deploymentId);
  const switching = route.name === "DeploymentSwitcher";
  const listInsets = useListContentInsets(space[32]);
  const column = useReadingColumn();
  const [refreshing, setRefreshing] = useState(false);
  const [startingAccountSignIn, setStartingAccountSignIn] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const accountFlowGeneration = useRef(0);
  const mounted = useRef(true);
  const pendingOpen = useRef<{ cancel: () => void } | null>(null);
  const visibleFailure =
    failure ??
    (directory.status === "error"
      ? (directory.detail ?? "Your Opensteer Account list could not be refreshed.")
      : null);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setFailure(null);
    void client
      .refreshDirectory()
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "Your Opensteer Account list could not be refreshed."));
      })
      .finally(() => setRefreshing(false));
  }, [client]);

  const open = useCallback(
    (row: DeploymentRow) => {
      if (!deploymentCanOpen(row)) {
        Alert.alert(row.name, deploymentStatusDetail(row) ?? "This deployment cannot open yet.", [
          ...(row.verification === "host-too-old"
            ? [{ text: "Update", onPress: () => resetToDeployment(row.deploymentId) }]
            : []),
          { text: "Done" },
        ]);
        return;
      }
      pendingOpen.current?.cancel();
      pendingOpen.current = null;
      if (switching && selection.deploymentId === row.deploymentId && row.signIn === null) {
        navigation.goBack();
        return;
      }
      setFailure(null);
      // Move only after the durable local selection publishes. That happens
      // before route verification, so an offline Host still opens promptly;
      // a failed device write stays on this sheet where its error can be read.
      const attempt = {
        active: true,
        cancel: (): void => {
          attempt.active = false;
          attempt.detach();
          if (pendingOpen.current === attempt) pendingOpen.current = null;
        },
        detach: (): void => undefined,
      };
      pendingOpen.current = attempt;
      let opened = false;
      const openSelected = (): void => {
        if (!attempt.active) return;
        if (client.getSnapshot().selection.deploymentId !== row.deploymentId) return;
        opened = true;
        attempt.cancel();
        void AccessibilityInfo.announceForAccessibility(`Opening ${row.name}`);
        resetToDeployment(row.deploymentId);
      };
      attempt.detach = client.subscribe(openSelected);
      openSelected();
      void client
        .openDeployment(row.deploymentId)
        .then(openSelected)
        .catch((error: unknown) => {
          const detail = operationDetail(error, "That deployment could not be opened.");
          // Selection resets the navigation tree before Host OAuth finishes.
          // An alert survives that reset, so a cancelled browser or rejected
          // callback does not disappear with this screen's local state.
          if (opened) Alert.alert("That deployment did not open", detail, [{ text: "Done" }]);
          else if (attempt.active) setFailure(detail);
          attempt.cancel();
        });
    },
    [client, navigation, selection.deploymentId, switching],
  );

  const openFromRow = useCallback(
    (row: DeploymentRow): void => {
      accountFlowGeneration.current += 1;
      setStartingAccountSignIn(false);
      open(row);
    },
    [open],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      accountFlowGeneration.current += 1;
      pendingOpen.current?.cancel();
      pendingOpen.current = null;
    };
  }, []);

  const recover = useCallback(
    (row: DeploymentRow): void => {
      accountFlowGeneration.current += 1;
      setStartingAccountSignIn(false);
      setFailure(null);
      void runDeploymentRecovery(client, navigation, row).catch((error: unknown) => {
        if (!mounted.current || !navigation.isFocused()) return;
        setFailure(operationDetail(error, "Sign-in did not finish. Try again."));
      });
    },
    [client, navigation],
  );

  const accountFlowIsCurrent = useCallback(
    (generation: number, expectedSelection: string | null): boolean =>
      accountFlowCanContinue({
        active: mounted.current && navigation.isFocused(),
        currentGeneration: accountFlowGeneration.current,
        currentSelection: client.getSnapshot().selection.deploymentId,
        expectedGeneration: generation,
        expectedSelection,
      }),
    [client, navigation],
  );

  const signInAccount = useCallback(() => {
    const generation = accountFlowGeneration.current + 1;
    accountFlowGeneration.current = generation;
    const expectedSelection = client.getSnapshot().selection.deploymentId;
    const openingComputer = client.getSnapshot().pendingComputer !== null;
    setFailure(null);
    setStartingAccountSignIn(true);
    void (async () => {
      await client.signInAccount();
      if (!accountFlowIsCurrent(generation, expectedSelection)) return;
      await client.refreshDirectory();
      if (!accountFlowIsCurrent(generation, expectedSelection)) return;
      if (openingComputer || client.getSnapshot().pendingComputer !== null) return;
      const singleton = eligibleSingletonDeployment(client.getSnapshot().rows);
      if (singleton !== null) open(singleton);
    })()
      .catch((error: unknown) => {
        if (!accountFlowIsCurrent(generation, expectedSelection)) return;
        setFailure(operationDetail(error, "Your Opensteer Account could not be reached."));
      })
      .finally(() => {
        if (mounted.current && accountFlowGeneration.current === generation) {
          setStartingAccountSignIn(false);
        }
      });
  }, [accountFlowIsCurrent, client, open]);

  const confirmRemove = useCallback(
    (row: DeploymentRow) => {
      Alert.alert(
        `Remove ${row.name}?`,
        row.deploymentId === enrolledIn
          ? `${phoneLeaves(thisPhoneNoun, row.name)} It also forgets the address and your sign-in.`
          : `This ${thisPhoneNoun} forgets its address and your sign-in.`,
        [
          { style: "cancel", text: "Keep" },
          {
            onPress: () => {
              void client
                .remove(row.deploymentId)
                .then(() => {
                  if (client.getSnapshot().selection.deploymentId === null) resetToDeployments();
                })
                .catch((error: unknown) => {
                  setFailure(operationDetail(error, "That deployment could not be removed."));
                });
            },
            style: "destructive",
            text: "Remove",
          },
        ],
      );
    },
    [client, enrolledIn],
  );

  const confirmSignOut = useCallback(
    (row: DeploymentRow) => {
      Alert.alert(
        `Sign out of ${row.name}?`,
        row.deploymentId === enrolledIn
          ? `${phoneLeaves(thisPhoneNoun, row.name)} It stays in this list.`
          : `This ${thisPhoneNoun} ends its session there and forgets the sign-in. It stays in this list.`,
        [
          { style: "cancel", text: "Stay signed in" },
          {
            onPress: () => {
              setFailure(null);
              void client.signOut(row.deploymentId).catch((error: unknown) => {
                setFailure(
                  operationDetail(error, "Signing out of that deployment did not finish."),
                );
              });
            },
            style: "destructive",
            text: "Sign out",
          },
        ],
      );
    },
    [client, enrolledIn],
  );

  const showDetails = useCallback((row: DeploymentRow): void => {
    Alert.alert(
      row.name,
      `${row.kindLabel}\n${row.origin}${
        row.accountManaged
          ? "\n\nThis deployment is managed by your Opensteer Account. Remove it from the Account to stop it appearing here."
          : ""
      }`,
      [{ text: "Done" }],
    );
  }, []);

  const visibleRows =
    switching && selection.deploymentId !== null
      ? [
          ...rows.filter((row) => row.deploymentId === selection.deploymentId),
          ...rows.filter((row) => row.deploymentId !== selection.deploymentId),
        ]
      : rows;

  const identity = account.account.identity;
  const presentation = deploymentsPresentation(rows.length, identity !== null);
  const welcome = presentation !== "list" && !switching;

  // The first run titles itself; a bar title above it would say it twice.
  useLayoutEffect(() => {
    if (switching) return;
    navigation.setOptions({ headerLargeTitle: !welcome, title: welcome ? "" : "Computers" });
  }, [navigation, switching, welcome]);

  const enterAddress = useCallback(() => {
    accountFlowGeneration.current += 1;
    setStartingAccountSignIn(false);
    navigation.navigate("AddPersonal");
  }, [navigation]);
  const scan = useSetupScanner(enterAddress);

  if (presentation === "welcome") {
    return (
      <Welcome
        portalOrigin={client.portalOrigin}
        account={account.account}
        failure={failure}
        onAccount={signInAccount}
        onAddress={enterAddress}
        onScan={() => {
          accountFlowGeneration.current += 1;
          setStartingAccountSignIn(false);
          scan();
        }}
        signingIn={startingAccountSignIn || account.account.status === "authorizing"}
      />
    );
  }

  if (presentation === "signed-in-empty") {
    const listed = signedInDirectoryPresentation({
      detail: directory.detail,
      status: directory.status,
      unavailableCount: directory.unavailable.length,
    });
    return (
      <SignedInWaiting onRefresh={refresh}>
        <Welcome
          account={account.account}
          failure={directory.status === "error" ? listed.detail : failure}
          onAccount={signInAccount}
          onAddress={enterAddress}
          onScan={scan}
          portalOrigin={client.portalOrigin}
          signedInAs={accountIdentityLabel(identity!)}
          signingIn={false}
        />
      </SignedInWaiting>
    );
  }

  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.list, column, listInsets]}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          account.account.status === "signed-in" ? (
            <RefreshControl onRefresh={refresh} refreshing={refreshing} tintColor={color.muted} />
          ) : undefined
        }
      >
        {visibleFailure === null ? null : (
          <Notice detail={visibleFailure} title="Something did not work" />
        )}
        {identity === null ? null : (
          <RowGroup>
            {[
              <AccountIdentityRow
                email={accountIdentityLabel(identity)}
                issuer={identity.issuer}
                key="account"
              />,
            ]}
          </RowGroup>
        )}
        <RowGroup>
          {visibleRows.map((row) => (
            <DeploymentListRow
              attention={attention.get(row.deploymentId)}
              current={selection.deploymentId === row.deploymentId}
              key={row.deploymentId}
              onDetails={showDetails}
              onOpen={openFromRow}
              onPair={recover}
              onRemove={confirmRemove}
              onSignOut={confirmSignOut}
              row={row}
            />
          ))}
        </RowGroup>
        <UnavailableAccountDeployments entries={directory.unavailable} hasAvailableRows />
      </ScrollView>
    </Screen>
  );
}

/**
 * Signed in, with no Opensteer yet: the Account is read again while this is on
 * screen and whenever the app returns, so it advances by itself once the Mac
 * has one.
 */
function SignedInWaiting(props: {
  readonly children: ReactNode;
  readonly onRefresh: () => void;
}): ReactNode {
  const { onRefresh } = props;
  useEffect(() => {
    const timer = setInterval(onRefresh, 20_000);
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") onRefresh();
    });
    return () => {
      clearInterval(timer);
      foreground.remove();
    };
  }, [onRefresh]);
  return props.children;
}

function UnavailableAccountDeployments(props: {
  readonly entries: readonly AccountDeploymentDirectoryUnavailable[];
  readonly hasAvailableRows: boolean;
}): ReactNode {
  if (props.entries.length === 0) return null;
  return (
    <View style={styles.unavailable}>
      <AppText role="secondaryMedium">Some Account deployments need attention</AppText>
      {props.hasAvailableRows ? (
        <AppText role="secondary" tone="muted">
          Deployments this phone could verify are still shown above.
        </AppText>
      ) : null}
      {props.entries.map((entry) => {
        const presentation = accountDirectoryUnavailablePresentation(entry);
        return (
          <Notice
            detail={presentation.detail}
            key={entry.deploymentId}
            title={presentation.title}
            tone="neutral"
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1, gap: space[2], minWidth: 0 },
  indicator: { alignItems: "center", justifyContent: "center", width: space[20] },
  kind: { flexShrink: 1 },
  list: { gap: space[12], paddingTop: space[12] },
  mark: {
    alignItems: "center",
    borderRadius: radius.sm,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  pair: {
    alignItems: "center",
    justifyContent: "center",
    maxWidth: 92,
    minHeight: touchTarget,
    paddingHorizontal: space[6],
  },
  pressed: { backgroundColor: color.surfacePressed },
  primary: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: space[12],
    minHeight: 60,
    minWidth: 0,
    paddingLeft: space[12],
    paddingVertical: space[10],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 60,
    paddingRight: space[4],
  },
  statusLine: { alignItems: "center", flexDirection: "row", gap: space[6], minWidth: 0 },
  needsYou: {
    alignItems: "center",
    backgroundColor: color.amber,
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[2],
    paddingHorizontal: space[6],
    paddingVertical: 1,
  },
  needsYouCount: { color: color.inkOnAmber, fontVariant: ["tabular-nums"], fontWeight: "700" },
  unreadMark: { alignItems: "center", height: 16, justifyContent: "center" },
  signals: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[8],
    marginTop: space[2],
  },
  teamSignal: { alignItems: "center", flexDirection: "row", gap: space[4], maxWidth: "100%" },
  unavailable: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[8],
    padding: space[12],
  },
});
