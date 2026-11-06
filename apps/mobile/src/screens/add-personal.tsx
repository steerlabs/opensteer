import type { VerifiedPersonalHostEndpoint } from "@opensteer/client/connections";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  addPersonalDeployment,
  defaultDeploymentName,
  verifyPersonalDeployment,
} from "../client/add-deployment.js";
import { operationDetail } from "../client/mobile-client.js";
import type { RootParamList } from "../navigation.js";
import { resetToDeployment } from "../navigation-ref.js";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { AppText, Field, Notice, PrimaryButton, RowGroup } from "../ui/primitives.js";
import { Screen, useReadingColumn } from "../ui/screen.js";
import { DeploymentDoorSymbol } from "./add-deployment.js";

/**
 * The personal-computer door.
 *
 * The address and the code are asked for together because they arrive together:
 * the computer that hosts a Personal deployment shows both. The route is
 * verified first, then the code is redeemed exactly once for a session this
 * phone keeps. A Host that will not hand a phone a session says so — there is
 * no cookie for a phone to fall back on, and pretending otherwise would leave a
 * row in the list that can never open.
 *
 * A pairing link or a scanned code arrives as route params. They are moved into
 * this screen's state and cleared from the route at once, so the code lives only
 * as long as this sheet, and nothing is sent anywhere until the person confirms
 * the address with Connect.
 */
export function AddPersonalScreen(): ReactNode {
  const client = useMobileClient();
  const column = useReadingColumn();
  const navigation = useNavigation();
  const offered = useRoute<RouteProp<RootParamList, "AddPersonal">>().params;
  const [origin, setOrigin] = useState(offered?.origin ?? "https://");
  const [pairingCode, setPairingCode] = useState(offered?.code ?? "");
  const [confirming, setConfirming] = useState(offered?.code !== undefined);
  const [verified, setVerified] = useState<VerifiedPersonalHostEndpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (offered?.code === undefined) return;
    setOrigin(offered.origin ?? "https://");
    setPairingCode(offered.code);
    setConfirming(true);
    setVerified(null);
    setFailure(null);
    navigation.setParams({ code: undefined, origin: undefined });
  }, [navigation, offered?.code, offered?.origin]);

  const connect = useCallback(() => {
    setBusy(true);
    setFailure(null);
    void (async () => {
      const endpoint =
        verified ??
        (await verifyPersonalDeployment({ fetch: globalThis.fetch, origin: origin.trim() }));
      setVerified(endpoint);
      await addPersonalDeployment({
        catalog: client.catalog,
        exchange: client.sessionExchange,
        name: defaultDeploymentName(endpoint.endpoint.origin, true),
        pairingCode: pairingCode.trim(),
        sessions: client.sessions,
        verified: endpoint,
      });
      setPairingCode("");
      await client.reconcile();
      const deploymentId = endpoint.discovery.deploymentId;
      await client.openDeployment(deploymentId);
      resetToDeployment(deploymentId);
    })()
      .catch((error: unknown) => {
        setFailure(
          operationDetail(error, "That computer did not accept this phone with that code."),
        );
      })
      .finally(() => setBusy(false));
  }, [client, origin, pairingCode, verified]);

  const failureNotice =
    failure === null ? null : (
      <Notice detail={failure} title="That computer did not let this phone in" />
    );

  if (confirming) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={[styles.content, column]}>
          <Heading title="Connect to this computer?" />
          <AppText role="secondary" tone="muted">
            Connect only if you just scanned this code on your own computer. The code works once and
            expires in a few minutes.
          </AppText>
          {failureNotice}
          <RowGroup>
            {[
              <View key="address" style={styles.summary}>
                <AppText numberOfLines={2} role="title" selectable>
                  {hostOf(origin)}
                </AppText>
                <AppText numberOfLines={2} role="caption" selectable tone="muted">
                  {origin}
                </AppText>
              </View>,
            ]}
          </RowGroup>
          <PrimaryButton busy={busy} label="Connect" onPress={connect} prominent />
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.content, column]}
        keyboardShouldPersistTaps="handled"
      >
        <Heading title="Connect by address" />
        <AppText role="secondary" tone="muted">
          Enter the address and pairing code your computer shows under Connect your phone.
        </AppText>
        {failureNotice}
        {verified === null ? null : (
          <RowGroup>
            {[
              <View key="summary" style={styles.summary}>
                <AppText role="title">{verified.discovery.canonicalOrigin}</AppText>
                <AppText role="caption" tone="muted">
                  Reached at {verified.endpoint.origin}
                </AppText>
              </View>,
            ]}
          </RowGroup>
        )}
        <RowGroup>
          {[
            <View key="address" style={styles.fieldRow}>
              <Field
                hint="The HTTPS address that computer is published at"
                input={{
                  autoCapitalize: "none",
                  autoCorrect: false,
                  inputMode: "url",
                  onChangeText: (value) => {
                    setOrigin(value);
                    setVerified(null);
                  },
                  placeholder: "https://",
                  value: origin,
                }}
                label="Address"
              />
            </View>,
            <View key="code" style={styles.fieldRow}>
              <Field
                hint="One use only. Ask that computer for a new one if this fails."
                input={{
                  autoCapitalize: "none",
                  // A code that arrived in a message is offered from the keyboard
                  // instead of being retyped from the other screen.
                  autoComplete: "one-time-code",
                  autoCorrect: false,
                  onChangeText: setPairingCode,
                  onSubmitEditing: connect,
                  placeholder: "Pairing code",
                  returnKeyType: "go",
                  textContentType: "oneTimeCode",
                  value: pairingCode,
                }}
                label="Pairing code"
              />
            </View>,
          ]}
        </RowGroup>
        <PrimaryButton
          busy={busy}
          disabled={pairingCode.trim().length === 0}
          label="Connect"
          onPress={connect}
          prominent
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.navigate("AddServer")}
          style={({ pressed }) => [styles.quiet, pressed && styles.pressed]}
        >
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondary" tone="ember">
            Add a server instead
          </AppText>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

function Heading(props: { readonly title: string }): ReactNode {
  return (
    <View style={styles.heading}>
      <View style={styles.headingMark}>
        <DeploymentDoorSymbol kind="computer" size={22} />
      </View>
      <AppText role="displaySmall" style={styles.headingText}>
        {props.title}
      </AppText>
    </View>
  );
}

/** The computer's name in its address, which is what a person recognises. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

const styles = StyleSheet.create({
  content: { gap: space[16], paddingBottom: space[32], paddingTop: space[8] },
  fieldRow: { padding: space[12] },
  heading: { alignItems: "center", flexDirection: "row", gap: space[12] },
  headingMark: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderColor: color.emberLine,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  headingText: { flex: 1 },
  pressed: { backgroundColor: color.surfacePressed },
  quiet: {
    alignItems: "center",
    alignSelf: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  summary: {
    gap: space[4],
    padding: space[14],
  },
});
