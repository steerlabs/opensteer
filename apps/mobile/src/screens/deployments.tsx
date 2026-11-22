import { cloudComputerWebsite } from "@opensteer/client/computers";
import { useCloudComputer } from "@opensteer/client/react";
import { useCopy } from "../ui/copy-mark.js";
import { phoneShowsCloudComputerPrice } from "./cloud-computer-entry.js";
import { clientIssue, presentClientIssue } from "@opensteer/client/feedback";
import { useNavigation, useRoute } from "@react-navigation/native";
import { hostsDeployment } from "@opensteer/client/computers";
import type { AccountDeploymentDirectoryUnavailable } from "@opensteer/client/connections";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import {
  deploymentStatusDetail,
  deploymentStatusLabel,
  listedKind,
  type DeploymentRow,
  type DeploymentStatus,
} from "../client/deployment-rows.js";
import { resetToDeployment, resetToDeployments } from "../navigation-ref.js";
import {
  color,
  controlFontScaleLimit,
  statusFontScaleLimit,
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
  homeLine,
  sameAttention,
  type AttentionBadge,
  type ComputerAttention,
} from "./computer-signals.js";
import {
  useMobileClient,
  useMobileState,
  useSelectedHostClient,
} from "../ui/mobile-client-context.js";
import { ActionLine, type ActionLineValue } from "../ui/action-line.js";
import { AppText, Notice, RowGroup, StatusDot } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { AccountIdentityRow } from "./add-deployment.js";
import {
  accountDirectoryUnavailablePresentation,
  accountSignInFailureText,
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
import { useCloudComputerIds, useWorkBadges } from "./work-home.js";
import { deploymentsTitle } from "./deployments-title.js";

const signedInStatuses: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "connected",
  "connecting",
  "offline",
  "reconnecting",
  "signed-in",
]);

export const DeploymentListRow = memo(function DeploymentListRow(props: {
  /** This computer's one read when the list opened; undefined until it answers. */
  readonly attention: ComputerAttention | null | undefined;
  readonly current: boolean;
  readonly onDetails: (row: DeploymentRow) => void;
  readonly onOpen: (row: DeploymentRow) => void;
  readonly onPair: (row: DeploymentRow) => void;
  readonly onRemove: (row: DeploymentRow) => void;
  readonly onSignOut: (row: DeploymentRow) => void;
  readonly row: DeploymentRow;
  /** "Work · {organization}" when an organization pays for and governs this Home. */
  readonly work?: string | undefined;
  /** The Account says this Home is an Opensteer Cloud Computer. */
  readonly cloud?: boolean;
}): ReactNode {
  const row = props.row;
  const kind = listedKind(row, props.cloud === true);
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
            ? "Opens this Opensteer and signs in when needed"
            : "Explains what must be fixed before this Opensteer can open"
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
          {/* A Home's name wraps: cut to "Mock…" at a large text size, two Homes read alike. */}
          <AppText role="title">{row.name}</AppText>
          {/* Every line under the name is a sentence or a name a person reads whole: none is cut. */}
          {props.work ? (
            <AppText role="caption" tone="muted">
              {props.work}
            </AppText>
          ) : null}
          <View style={styles.statusLine}>
            <StatusDot
              live={row.status === "connecting" || row.status === "reconnecting"}
              tone={statusTone(row.status)}
            />
            <AppText maxFontSizeMultiplier={statusFontScaleLimit} role="caption" tone="muted">
              {deploymentStatusLabel(row.status)}
            </AppText>
            <AppText role="caption" tone="muted">
              ·
            </AppText>
            {kind.cloud ? (
              <View style={styles.cloudKind}>
                <Symbol name="cloud" size={11} tint={color.muted} />
                <KindText text={kind.label} />
              </View>
            ) : (
              <RowKind
                current={props.current}
                kindLabel={row.kindLabel}
                name={row.name}
                read={props.attention}
              />
            )}
          </View>
          {detail === null ? null : (
            <AppText role="caption" tone="muted">
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
 * What a computer has waiting: its own Needs you count or unread dot. The shown computer
 * speaks from its live snapshot; another from the one read made when the list
 * opened. Personal and work computers read alike, so the other is a glance away.
 */
function ComputerSignals(props: {
  readonly computerId: string;
  readonly current: boolean;
  readonly read: ComputerAttention | null | undefined;
}): ReactNode {
  const host = useSelectedHostClient();
  const shown = props.current && host !== null;
  const read = computerBadge({ current: false, shown: null, read: props.read });
  if (!shown && read === null) return null;
  return (
    <View style={styles.signals}>
      {shown ? <ShownBadge host={host} /> : <Badge badge={read} />}
    </View>
  );
}

/** The shown computer's own attention, from the list it already holds: no request. */
function ShownBadge(props: { readonly host: HostClient }): ReactNode {
  const shown = useHostSelector(props.host, shownAttention, sameAttention);
  return <Badge badge={computerBadge({ current: true, shown, read: undefined })} />;
}

function RowKind(props: {
  readonly current: boolean;
  readonly kindLabel: string;
  readonly name: string;
  readonly read: ComputerAttention | null | undefined;
}): ReactNode {
  const host = useSelectedHostClient();
  if (props.current && host !== null) return <ShownKind {...props} host={host} />;
  return <KindText text={homeLine(props.read, props.name) ?? props.kindLabel} />;
}

function ShownKind(props: {
  readonly host: HostClient;
  readonly kindLabel: string;
  readonly name: string;
}): ReactNode {
  const shown = useHostSelector(props.host, shownAttention, sameAttention);
  return <KindText text={homeLine(shown, props.name) ?? props.kindLabel} />;
}

/** The Home's kind, or the Mac it lives on: wraps, and moves to its own line when it must. */
function KindText(props: { readonly text: string }): ReactNode {
  return (
    <AppText role="caption" style={styles.kind} tone="muted">
      {props.text}
    </AppText>
  );
}

let shownHeld: { readonly source: HostSnapshot; readonly value: ComputerAttention } | null = null;
function shownAttention(snapshot: HostSnapshot): ComputerAttention {
  const needsYou = snapshot.needsYou?.count ?? 0;
  const homeName = snapshot.machines.find(hostsDeployment)?.name ?? null;
  if (
    shownHeld !== null &&
    sameTaskListSource(shownHeld.source, snapshot) &&
    needsYou === shownHeld.value.needsYou &&
    homeName === shownHeld.value.homeName
  )
    return shownHeld.value;
  const value = {
    homeName,
    needsYou,
    unread: taskList(snapshot).ready.some((row) => row.unread),
  };
  shownHeld = { source: snapshot, value };
  return value;
}

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
  const workBadges = useWorkBadges();
  const cloudIds = useCloudComputerIds();
  const switching = route.name === "DeploymentSwitcher";
  const listInsets = useListContentInsets(space[32]);
  const column = useReadingColumn();
  const [refreshing, setRefreshing] = useState(false);
  const [startingAccountSignIn, setStartingAccountSignIn] = useState(false);
  const [failure, setFailure] = useState<ActionLineValue | null>(null);
  const accountFlowGeneration = useRef(0);
  const mounted = useRef(true);
  const pendingOpen = useRef<{ cancel: () => void } | null>(null);
  // A background reread that fails keeps the list as it was and says nothing.
  const refresh = useCallback(() => {
    setRefreshing(true);
    setFailure(null);
    void client
      .refreshDirectory()
      .catch((error: unknown) =>
        setFailure(
          failedLine(
            error,
            presentClientIssue({ code: "refresh-failed", resource: "your computers" }).title,
          ),
        ),
      )
      .finally(() => setRefreshing(false));
  }, [client]);

  const open = useCallback(
    (row: DeploymentRow) => {
      if (!deploymentCanOpen(row)) {
        Alert.alert(row.name, deploymentStatusDetail(row) ?? "This Opensteer cannot open yet.", [
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
          const line = failedLine(error, `Couldn't open ${row.name}.`);
          // Selection resets the navigation tree before Host OAuth finishes.
          // An alert survives that reset, so a rejected callback does not
          // disappear with this screen's local state.
          if (line !== null && opened)
            Alert.alert(line.text, `Try again from ${deploymentsTitle}.`, [{ text: "Done" }]);
          else if (attempt.active) setFailure(line);
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
        setFailure(failedLine(error, "Sign-in didn't finish.", () => recover(row)));
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
        setFailure(failedLine(error, accountSignInFailureText(error)));
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
                  setFailure(failedLine(error, `Couldn't remove ${row.name}.`));
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
                setFailure(failedLine(error, `Couldn't sign out of ${row.name}.`));
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
          ? "\n\nThis Opensteer is in your Opensteer account. Remove it there to stop it appearing here."
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
    navigation.setOptions({ headerLargeTitle: !welcome, title: welcome ? "" : deploymentsTitle });
  }, [navigation, switching, welcome]);

  // A price is read only where the phone may show one (phoneShowsCloudComputerPrice).
  const cloud = useCloudComputer(phoneShowsCloudComputerPrice ? client.cloudComputers : null);
  const { copied, copy } = useCopy();
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
        failure={failure?.text ?? null}
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
    const cloudScreen = cloud.screen;
    const listed = signedInDirectoryPresentation({
      detail: directory.detail,
      status: directory.status,
      unavailableCount: directory.unavailable.length,
    });
    return (
      <SignedInWaiting onRefresh={refresh}>
        <Welcome
          account={account.account}
          failure={directory.status === "error" ? listed.detail : (failure?.text ?? null)}
          onAccount={signInAccount}
          onAddress={enterAddress}
          onScan={scan}
          portalOrigin={client.portalOrigin}
          signedInAs={accountIdentityLabel(identity!)}
          signingIn={false}
          cloudAddress={
            client.portalOrigin ? cloudComputerWebsite(client.portalOrigin, "checkout") : null
          }
          cloudCopied={copied}
          cloudPrice={cloudScreen.kind === "offer" ? (cloudScreen.plan?.line ?? null) : null}
          onCopyCloudAddress={(address) => void copy(address)}
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
        {failure === null ? null : (
          <ActionLine line={failure} numberOfLines={2} onDismiss={() => setFailure(null)} />
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
              work={workBadges.get(row.deploymentId)}
              cloud={cloudIds.has(row.deploymentId)}
            />
          ))}
        </RowGroup>
        <UnavailableAccountDeployments entries={directory.unavailable} hasAvailableRows />
      </ScrollView>
    </Screen>
  );
}

/** The Account is read again while this is on screen and on return, so it advances by itself. */
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
      <AppText role="secondaryMedium">Some Opensteers in your account need attention</AppText>
      {props.hasAvailableRows ? (
        <AppText role="secondary" tone="muted">
          Opensteers this phone could verify are still shown above.
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

/**
 * A device or Account step that failed, in the screen's own words; nothing
 * for a person who cancelled. These never reach the computer's own answer,
 * so there is no reason to read out, only what didn't happen.
 */
function failedLine(error: unknown, text: string, retry?: () => void): ActionLineValue | null {
  if (clientIssue(error, { operation: "action", label: text }) === null) return null;
  return {
    key: text,
    text,
    tone: "muted",
    link: retry ? { label: "Try again", onPress: retry } : null,
    haptic: "warning",
  };
}

const styles = StyleSheet.create({
  cloudKind: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: space[2] },
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
  // At a large text size the status and kind move to the next line whole, never broken
  // inside a word.
  statusLine: {
    alignItems: "center",
    columnGap: space[6],
    flexDirection: "row",
    flexWrap: "wrap",
    minWidth: 0,
  },
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
  unavailable: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[8],
    padding: space[12],
  },
});
