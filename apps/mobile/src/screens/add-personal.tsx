import type { VerifiedPersonalHostEndpoint } from "@opensteer/client/connections";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  addPersonalDeployment,
  defaultDeploymentName,
  verifyPersonalDeployment,
} from "../client/add-deployment.js";
import { operationDetail } from "../client/mobile-client.js";
import { resetToDeployment } from "../navigation-ref.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import {
  AppText,
  Field,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
} from "../ui/primitives.js";
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
 */
export function AddPersonalScreen(): ReactNode {
  const client = useMobileClient();
  const column = useReadingColumn();
  const navigation = useNavigation();
  const [origin, setOrigin] = useState("https://");
  const [pairingCode, setPairingCode] = useState("");
  const [verified, setVerified] = useState<VerifiedPersonalHostEndpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

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

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.content, column]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heading}>
          <View style={styles.headingMark}>
            <DeploymentDoorSymbol kind="computer" size={22} />
          </View>
          <AppText role="displaySmall" style={styles.headingText}>
            Pair a computer
          </AppText>
        </View>
        <AppText role="secondary" tone="muted">
          Open Opensteer on that computer, turn on remote access, and it will show you an address
          and a pairing code.
        </AppText>
        {failure === null ? null : (
          <Notice detail={failure} title="That computer did not let this phone in" />
        )}
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
                  autoCapitalize: "characters",
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
        />
        <SecondaryButton label="Cancel" onPress={() => navigation.goBack()} />
      </ScrollView>
    </Screen>
  );
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
  summary: {
    gap: space[4],
    padding: space[14],
  },
});
