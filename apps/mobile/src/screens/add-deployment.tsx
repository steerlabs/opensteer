import { useNavigation } from "@react-navigation/native";
import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { resetToDeployment, resetToDeployments } from "../navigation-ref.js";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { Screen, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import {
  accountFlowCanContinue,
  accountDoorPresentation,
  accountIdentityLabel,
  eligibleSingletonDeployment,
} from "./account-door.js";
import { deploymentInitial } from "./deployment-row.js";

export function AccountIdentityRow(props: {
  readonly email: string;
  readonly issuer: string;
}): ReactNode {
  return (
    <View accessibilityLabel={`Opensteer Account ${props.email}`} style={styles.accountRow}>
      <View style={styles.accountMark}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="title" tone="ember">
          {deploymentInitial(props.email)}
        </AppText>
      </View>
      <View style={styles.accountCopy}>
        <AppText numberOfLines={1} role="title">
          {props.email}
        </AppText>
        <AppText numberOfLines={1} role="caption" tone="muted">
          {props.issuer}
        </AppText>
      </View>
      <Symbol name="person.crop.circle" size={18} tint={color.mutedDim} />
    </View>
  );
}

/**
 * Three doors, in the order most people need them.
 *
 * They are not variants of one form: each begins a different trust
 * relationship, so each says who it is for rather than what it technically
 * does. Whichever the person picks, nothing is added until the address has
 * proved which Deployment it serves.
 */
export function AddDeploymentScreen(): ReactNode {
  const client = useMobileClient();
  const navigation = useNavigation();
  const { account } = useMobileState();
  const column = useReadingColumn();
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [startingSignIn, setStartingSignIn] = useState(false);
  const accountFlowGeneration = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      accountFlowGeneration.current += 1;
    };
  }, []);

  const flowIsCurrent = useCallback(
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

  const refreshAndClose = useCallback(async () => {
    const generation = accountFlowGeneration.current + 1;
    accountFlowGeneration.current = generation;
    const expectedSelection = client.getSnapshot().selection.deploymentId;
    setFailure(null);
    setRefreshing(true);
    try {
      await client.refreshDirectory();
      if (!flowIsCurrent(generation, expectedSelection)) return;
      const deploymentId = client.getSnapshot().selection.deploymentId;
      if (deploymentId === null) navigation.goBack();
      else resetToDeployment(deploymentId);
    } catch (error: unknown) {
      if (!flowIsCurrent(generation, expectedSelection)) return;
      setFailure(operationDetail(error, "Your Opensteer Account list could not be refreshed."));
    } finally {
      if (mounted.current && accountFlowGeneration.current === generation) setRefreshing(false);
    }
  }, [client, flowIsCurrent, navigation]);

  const signIn = useCallback(() => {
    const generation = accountFlowGeneration.current + 1;
    accountFlowGeneration.current = generation;
    const expectedSelection = client.getSnapshot().selection.deploymentId;
    let destination: string | null = null;
    setFailure(null);
    setStartingSignIn(true);
    void (async () => {
      await client.signInAccount();
      if (!flowIsCurrent(generation, expectedSelection)) return;
      await client.refreshDirectory();
      if (!flowIsCurrent(generation, expectedSelection)) return;
      const singleton = eligibleSingletonDeployment(client.getSnapshot().rows);
      if (singleton === null) {
        resetToDeployments();
        return;
      }
      destination = singleton.deploymentId;
      await client.openDeployment(singleton.deploymentId);
      if (!flowIsCurrent(generation, singleton.deploymentId)) return;
      resetToDeployment(singleton.deploymentId);
    })()
      .catch((error: unknown) => {
        if (
          !flowIsCurrent(generation, expectedSelection) &&
          (destination === null || !flowIsCurrent(generation, destination))
        ) {
          return;
        }
        setFailure(operationDetail(error, "Your Opensteer Account could not be reached."));
      })
      .finally(() => {
        if (mounted.current && accountFlowGeneration.current === generation) {
          setStartingSignIn(false);
        }
      });
  }, [client, flowIsCurrent, navigation]);

  const openPersonal = useCallback(() => {
    accountFlowGeneration.current += 1;
    setStartingSignIn(false);
    navigation.navigate("AddPersonal");
  }, [navigation]);

  const openServer = useCallback(() => {
    accountFlowGeneration.current += 1;
    setStartingSignIn(false);
    navigation.navigate("AddServer");
  }, [navigation]);

  const identity = account.account.identity;
  const signingIn = startingSignIn || account.account.status === "authorizing";

  return (
    <Screen>
      {/* The header already says what this sheet is for, so the sheet does not
          say it a second time in the display face; the doors are the content. */}
      <ScrollView contentContainerStyle={[styles.content, column]}>
        {failure === null ? null : <Notice detail={failure} title="That did not work" />}
        {identity === null ? (
          <AddDeploymentDoors
            account={account.account}
            onAccount={signIn}
            onPersonal={openPersonal}
            onServer={openServer}
            signingIn={signingIn}
          />
        ) : (
          <>
            <RowGroup>
              {[
                <AccountIdentityRow
                  email={accountIdentityLabel(identity)}
                  issuer={identity.issuer}
                  key="account"
                />,
              ]}
            </RowGroup>
            <View style={styles.accountAction}>
              <SecondaryButton
                disabled={refreshing}
                label={refreshing ? "Refreshing…" : "Refresh Account deployments"}
                onPress={() => void refreshAndClose()}
              />
            </View>
            <ManualDeploymentDoors onPersonal={openPersonal} onServer={openServer} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * The doors themselves, so the Deployments screen can offer them where a person
 * with nothing listed already is rather than sending them to a sheet for the
 * same three rows. One home for the words, two places that show them.
 */
export function AddDeploymentDoors(props: {
  readonly account: DesktopAccountAuthState["account"];
  readonly onAccount: () => void;
  readonly onPersonal: () => void;
  readonly onServer: () => void;
  readonly signingIn?: boolean;
}): ReactNode {
  const account = accountDoorPresentation(props.account, props.signingIn === true);
  return (
    <RowGroup>
      {[
        <DeploymentDoorRow
          description={account.description}
          // A door that cannot open is drawn shut rather than left to look
          // pressable and do nothing.
          disabled={account.disabled}
          key="account"
          symbol="account"
          onPress={props.onAccount}
          title={account.title}
        />,
        ...manualDeploymentDoorRows(props),
      ]}
    </RowGroup>
  );
}

export function ManualDeploymentDoors(props: {
  readonly onPersonal: () => void;
  readonly onServer: () => void;
}): ReactNode {
  return <RowGroup>{manualDeploymentDoorRows(props)}</RowGroup>;
}

function manualDeploymentDoorRows(props: {
  readonly onPersonal: () => void;
  readonly onServer: () => void;
}): readonly ReactNode[] {
  return [
    <DeploymentDoorRow
      description="You know the address of a deployment someone runs."
      key="server"
      onPress={props.onServer}
      symbol="server"
      title="Add a server by address"
    />,
    <DeploymentDoorRow
      description="You have a pairing code from the computer that hosts it."
      key="personal"
      onPress={props.onPersonal}
      symbol="computer"
      title="Pair a computer"
    />,
  ];
}

function DeploymentDoorRow(props: {
  readonly description: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly symbol: DeploymentDoorSymbolKind;
  readonly title: string;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.door,
        pressed && styles.doorPressed,
        props.disabled === true && styles.disabled,
      ]}
    >
      <View style={styles.doorMark}>
        <DeploymentDoorSymbol kind={props.symbol} />
      </View>
      <View style={styles.doorCopy}>
        <AppText role="bodyMedium">{props.title}</AppText>
        <AppText role="secondary" tone="muted">
          {props.description}
        </AppText>
      </View>
      <Symbol name="chevron.right" size={13} tint={color.mutedDim} />
    </Pressable>
  );
}

export type DeploymentDoorSymbolKind = "account" | "computer" | "server";

export function DeploymentDoorSymbol(props: {
  readonly kind: DeploymentDoorSymbolKind;
  readonly size?: number;
}): ReactNode {
  const size = props.size ?? 20;
  if (props.kind === "account") {
    return <Symbol name="person.crop.circle" size={size} tint={color.ember} />;
  }
  const names: readonly [primary: SFSymbol, fallback: SFSymbol] =
    props.kind === "server" ? ["server.rack", "network"] : ["laptopcomputer", "desktopcomputer"];
  const lastFallback = <Symbol name="cpu" size={size} tint={color.ember} />;
  return (
    <SymbolView
      accessibilityElementsHidden
      fallback={
        <SymbolView
          accessibilityElementsHidden
          fallback={lastFallback}
          importantForAccessibility="no-hide-descendants"
          name={names[1]}
          size={size}
          tintColor={color.ember}
        />
      }
      importantForAccessibility="no-hide-descendants"
      name={names[0]}
      size={size}
      tintColor={color.ember}
    />
  );
}

const styles = StyleSheet.create({
  accountCopy: { flex: 1, gap: space[2], minWidth: 0 },
  accountMark: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderColor: color.emberLine,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  accountRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 60,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  accountAction: { alignItems: "flex-start", paddingTop: space[8] },
  content: { gap: space[16], paddingBottom: space[32], paddingTop: space[12] },
  disabled: { opacity: 0.46 },
  door: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 64,
    paddingHorizontal: space[12],
    paddingVertical: space[10],
  },
  doorCopy: { flex: 1, gap: space[2], minWidth: 0 },
  doorMark: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderColor: color.emberLine,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  doorPressed: { backgroundColor: color.surfacePressed },
});
