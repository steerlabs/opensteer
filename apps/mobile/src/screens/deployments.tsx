import { useHeaderHeight } from "@react-navigation/elements";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { AccountDeploymentDirectoryUnavailable } from "@opensteer/client/connections";
import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { operationDetail } from "../client/mobile-client.js";
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
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, RowGroup, SecondaryButton, StatusDot } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { AccountIdentityRow, ManualDeploymentDoors } from "./add-deployment.js";
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
import { Welcome } from "./welcome.js";

const signedInStatuses: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "connected",
  "connecting",
  "offline",
  "reconnecting",
  "signed-in",
]);

const DeploymentListRow = memo(function DeploymentListRow(props: {
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
  const switching = route.name === "DeploymentSwitcher";
  const listInsets = useListContentInsets(space[32]);
  const column = useReadingColumn();
  const headerHeight = useHeaderHeight();
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
    setFailure(null);
    setStartingAccountSignIn(true);
    void (async () => {
      await client.signInAccount();
      if (!accountFlowIsCurrent(generation, expectedSelection)) return;
      await client.refreshDirectory();
      if (!accountFlowIsCurrent(generation, expectedSelection)) return;
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
      Alert.alert(`Remove ${row.name}?`, "This phone forgets its address and your sign-in.", [
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
      ]);
    },
    [client],
  );

  const confirmSignOut = useCallback(
    (row: DeploymentRow) => {
      Alert.alert(
        `Sign out of ${row.name}?`,
        "This phone ends its session there and forgets the sign-in. The deployment stays in this list.",
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
    [client],
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

  if (presentation !== "list") {
    return (
      <Screen>
        <ScrollView
          // The bar's height is stated as padding rather than left to the
          // automatic inset: the inset would add it to a container that is
          // already the viewport's height, and centre the welcome column in a
          // box taller than the screen — visibly low on every phone.
          contentContainerStyle={[styles.empty, column, { paddingTop: headerHeight }]}
          contentInsetAdjustmentBehavior="never"
        >
          {presentation === "welcome" ? (
            <Welcome
              account={account.account}
              failure={failure}
              onAccount={signInAccount}
              onPersonal={() => {
                accountFlowGeneration.current += 1;
                setStartingAccountSignIn(false);
                navigation.navigate("AddPersonal");
              }}
              onServer={() => {
                accountFlowGeneration.current += 1;
                setStartingAccountSignIn(false);
                navigation.navigate("AddServer");
              }}
              signingIn={startingAccountSignIn || account.account.status === "authorizing"}
            />
          ) : (
            <SignedInEmptyDeployments
              directoryDetail={directory.detail}
              directoryStatus={directory.status}
              failure={failure}
              identity={identity!}
              onPersonal={() => navigation.navigate("AddPersonal")}
              onRefresh={refresh}
              onServer={() => navigation.navigate("AddServer")}
              refreshing={refreshing}
              unavailable={directory.unavailable}
            />
          )}
        </ScrollView>
      </Screen>
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

function SignedInEmptyDeployments(props: {
  readonly directoryDetail: string | null;
  readonly directoryStatus: "error" | "idle" | "loading" | "ready";
  readonly failure: string | null;
  readonly identity: NonNullable<DesktopAccountAuthState["account"]["identity"]>;
  readonly onPersonal: () => void;
  readonly onRefresh: () => void;
  readonly onServer: () => void;
  readonly refreshing: boolean;
  readonly unavailable: readonly AccountDeploymentDirectoryUnavailable[];
}): ReactNode {
  const presentation = signedInDirectoryPresentation({
    detail: props.directoryDetail,
    status: props.directoryStatus,
    unavailableCount: props.unavailable.length,
  });
  const refreshing = props.refreshing || presentation.refreshDisabled;
  return (
    <>
      {props.failure === null ? null : (
        <Notice detail={props.failure} title="Your Account list could not be refreshed" />
      )}
      <RowGroup>
        {[
          <AccountIdentityRow
            email={accountIdentityLabel(props.identity)}
            issuer={props.identity.issuer}
            key="account"
          />,
        ]}
      </RowGroup>
      <AppText role="displayLarge">{presentation.title}</AppText>
      <AppText role="secondary" tone="muted">
        {presentation.detail}
      </AppText>
      <UnavailableAccountDeployments entries={props.unavailable} hasAvailableRows={false} />
      <View style={styles.refreshAction}>
        <SecondaryButton
          disabled={refreshing}
          label={refreshing ? "Refreshing…" : presentation.refreshLabel}
          onPress={props.onRefresh}
        />
      </View>
      <View style={styles.emptyActions}>
        <ManualDeploymentDoors onPersonal={props.onPersonal} onServer={props.onServer} />
      </View>
    </>
  );
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
  empty: { flexGrow: 1, gap: space[16], justifyContent: "center" },
  emptyActions: { paddingTop: space[8] },
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
  refreshAction: { alignItems: "flex-start", paddingTop: space[4] },
  row: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 60,
    paddingRight: space[4],
  },
  statusLine: { alignItems: "center", flexDirection: "row", gap: space[6], minWidth: 0 },
  unavailable: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[8],
    padding: space[12],
  },
});
