import { deploymentAddressFailure } from "@opensteer/client/connections";
import { clientIssue } from "@opensteer/client/feedback";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import type { VerifiedDeploymentAddress } from "@opensteer/client/connections";
import { useCallback, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  addServerDeployment,
  defaultDeploymentName,
  verifyServerDeployment,
} from "../client/add-deployment.js";
import { resetToDeployment } from "../navigation-ref.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { AppText, Field, PrimaryButton, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { ActionLine } from "../ui/action-line.js";
import { Screen, useReadingColumn } from "../ui/screen.js";
import { DeploymentDoorSymbol } from "./add-deployment.js";

/**
 * The address door, for a Home on someone's own server, in two
 * steps on one screen.
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
  const [verified, setVerified] = useState<VerifiedDeploymentAddress | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const verify = useCallback(() => {
    setBusy(true);
    setFailure(null);
    void verifyServerDeployment({ fetch: globalThis.fetch, origin: origin.trim() })
      .then(setVerified)
      .catch((error: unknown) => {
        if (clientIssue(error, { operation: "action", label: "check" }) !== null)
          setFailure(deploymentAddressFailure(error));
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
        if (clientIssue(error, { operation: "action", label: "add" }) !== null)
          setFailure("Couldn’t add this Home.");
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
            Add a Home by address
          </AppText>
        </View>
        {failure === null ? null : (
          <ActionLine
            line={{
              key: failure,
              text: failure,
              tone: "muted",
              haptic: "warning",
              link: verified === null ? { label: "Try again", onPress: verify } : null,
            }}
            numberOfLines={2}
          />
        )}
        {verified === null ? (
          <>
            <RowGroup>
              {[
                <View key="address" style={styles.fieldRow}>
                  <Field
                    hint="The address of an Opensteer you run on your own server."
                    input={{
                      autoCapitalize: "none",
                      autoCorrect: false,
                      inputMode: "url",
                      onChangeText: setOrigin,
                      onSubmitEditing: verify,
                      placeholder: "https://home.example.com",
                      returnKeyType: "go",
                      value: origin,
                    }}
                    label="Home address"
                  />
                </View>,
              ]}
            </RowGroup>
            {/* Looking an address up commits to nothing, so it does not get
                the ember; that is spent on the step that adds the deployment. */}
            <SecondaryButton disabled={busy} label="Continue" onPress={verify} />
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
            <PrimaryButton busy={busy} label="Add Home" onPress={add} />
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
