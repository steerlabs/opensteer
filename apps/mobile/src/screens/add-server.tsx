import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import type { VerifiedHostEndpoint } from "@opensteer/client/connections";
import { useCallback, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  addServerDeployment,
  defaultDeploymentName,
  verifyServerDeployment,
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
 * The server door, in two steps on one screen.
 *
 * Step one asks the address and nothing else; step two shows what answered —
 * the Deployment's name and the fingerprint of the key that signed its
 * identity — before anything is added. The fingerprint is shown because it is
 * the only thing a person can compare against what the operator told them, and
 * a manual entry is pinned to it from then on.
 */
export function AddServerScreen(): ReactNode {
  const client = useMobileClient();
  const column = useReadingColumn();
  const [origin, setOrigin] = useState("https://");
  const [verified, setVerified] = useState<VerifiedHostEndpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const verify = useCallback(() => {
    setBusy(true);
    setFailure(null);
    void verifyServerDeployment({ fetch: globalThis.fetch, origin: origin.trim() })
      .then(setVerified)
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "Nothing at that address answered as a deployment."));
      })
      .finally(() => setBusy(false));
  }, [origin]);

  const add = useCallback(() => {
    if (verified === null) return;
    const deploymentId = verified.discovery.deploymentId;
    setBusy(true);
    setFailure(null);
    void addServerDeployment({
      catalog: client.catalog,
      name: defaultDeploymentName(verified.endpoint.origin, false),
      verified,
    })
      .then(() => client.reconcile())
      .then(() => client.openDeployment(deploymentId))
      .then(() => resetToDeployment(deploymentId))
      .catch((error: unknown) => {
        setFailure(operationDetail(error, "That deployment could not be added."));
      })
      .finally(() => setBusy(false));
  }, [client, verified]);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.content, column]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heading}>
          <View style={styles.headingMark}>
            <DeploymentDoorSymbol kind="server" size={22} />
          </View>
          <AppText role="displaySmall" style={styles.headingText}>
            Add a server by address
          </AppText>
        </View>
        {failure === null ? null : (
          <Notice
            action={{ label: "Try again", onPress: verify }}
            detail={failure}
            title="That address did not work"
          />
        )}
        {verified === null ? (
          <>
            <RowGroup>
              {[
                <View key="address" style={styles.fieldRow}>
                  <Field
                    hint="An HTTPS address, such as https://opensteer.example.com"
                    input={{
                      autoCapitalize: "none",
                      autoCorrect: false,
                      inputMode: "url",
                      onChangeText: setOrigin,
                      onSubmitEditing: verify,
                      placeholder: "https://",
                      returnKeyType: "go",
                      value: origin,
                    }}
                    label="Address"
                  />
                </View>,
              ]}
            </RowGroup>
            {/* Looking an address up commits to nothing, so it does not get
                the ember; that is spent on the step that adds the deployment. */}
            <SecondaryButton disabled={busy} label="Look it up" onPress={verify} />
          </>
        ) : (
          <>
            <RowGroup>
              {[
                <View key="summary" style={styles.summary}>
                  <AppText role="title">
                    {defaultDeploymentName(verified.endpoint.origin, false)}
                  </AppText>
                  <AppText role="secondary" tone="soft">
                    {verified.endpoint.origin}
                  </AppText>
                  <AppText role="caption" tone="muted">
                    Signing key {hostKeyFingerprint(verified.discoveryEnvelope.publicKey.spki)}
                  </AppText>
                </View>,
              ]}
            </RowGroup>
            <AppText role="secondary" tone="muted">
              Check that fingerprint against what the person who runs it told you. This phone will
              only ever talk to this exact deployment.
            </AppText>
            <PrimaryButton busy={busy} label="Add deployment" onPress={add} />
            <SecondaryButton label="Use a different address" onPress={() => setVerified(null)} />
          </>
        )}
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
