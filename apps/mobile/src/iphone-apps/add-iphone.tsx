import type { HostClient } from "@opensteer/client/host";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { space } from "../theme.js";
import { useHostValue, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Field, PrimaryButton, RowGroup, SectionLabel } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { useIphoneApps, useIphoneAppsState } from "./context.js";
import type { IphoneAppsController } from "./controller.js";
import {
  addIphoneApps,
  addIphoneAppsHeading,
  addIphoneAvailability,
  addIphoneFailureText,
  addIphoneIntro,
  addIphoneNameHint,
  addIphoneNeedsUpdate,
  addIphoneNothingElse,
  iphoneAppName,
  opensteerOn,
} from "./model.js";

export type AddIphoneScreenProps = StaticScreenProps<{ readonly deploymentId: string }>;

/** Adding this iPhone to the open Deployment, from Settings → Computers. */
export function AddIphoneScreen(props: AddIphoneScreenProps): ReactNode {
  const { deploymentId } = props.route.params;
  const navigation = useNavigation();
  const controller = useIphoneApps();
  const { rows, selection } = useMobileState();
  const row = rows.find((candidate) => candidate.deploymentId === deploymentId);
  const hostClient =
    selection.deploymentId === deploymentId && row?.signIn === null ? selection.hostClient : null;
  const available = useHostValue(hostClient, (snapshot) => snapshot.iphoneAppsAvailable, false);
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {row === undefined || hostClient === null ? (
          <AppText role="secondary" tone="muted">
            {row === undefined
              ? "This deployment is no longer on this phone."
              : `Open ${row.name} to add this iPhone to it.`}
          </AppText>
        ) : (
          <AddIphoneForm
            controller={controller}
            deploymentId={deploymentId}
            hostClient={hostClient}
            iphoneAppsAvailable={available}
            onAdded={(runnerId) =>
              navigation.dispatch(
                StackActions.replace("Computer", { deploymentId, machineId: runnerId }),
              )
            }
            opensteer={opensteerOn(row.name)}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * What adding shares — nothing until an app is turned on — then the iPhone's
 * name and Add. The Host must say it can take an
 * iPhone before Add is offered at all.
 */
export function AddIphoneForm(props: {
  readonly controller: IphoneAppsController;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly iphoneAppsAvailable: boolean;
  readonly onAdded: (runnerId: string) => void;
  readonly opensteer: string;
}): ReactNode {
  const state = useIphoneAppsState(props.controller);
  const [name, setName] = useState(() => props.controller.getState().snapshot.deviceName);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const adding = state.adding === props.deploymentId;
  const trimmed = name.trim();

  const add = (): void => {
    if (adding || trimmed === "") return;
    setFailure(null);
    void props.controller
      .add({
        deploymentId: props.deploymentId,
        hostClient: props.hostClient,
        iphoneAppsAvailable: props.iphoneAppsAvailable,
        name: trimmed,
      })
      .then((outcome) => {
        if (!mounted.current) return;
        if (outcome.kind === "added") props.onAdded(outcome.runnerId);
        else if (outcome.kind === "failed") {
          setFailure(addIphoneFailureText(outcome.failure, props.opensteer));
        }
      });
  };

  return (
    <View style={styles.form}>
      <AppText role="body">{addIphoneIntro(props.opensteer)}</AppText>
      <Field
        hint={addIphoneNameHint}
        input={{
          autoCapitalize: "words",
          autoCorrect: false,
          editable: !adding,
          maxLength: 120,
          onChangeText: setName,
          returnKeyType: "done",
          value: name,
        }}
        label="Name"
      />
      <View style={styles.section}>
        <SectionLabel>{addIphoneAppsHeading}</SectionLabel>
        <RowGroup>
          {addIphoneApps.map((app) => (
            <View key={app.id} style={styles.app}>
              <AppText role="body">{iphoneAppName(app.id)}</AppText>
              <AppText role="secondary" tone="muted">
                {app.detail}
              </AppText>
            </View>
          ))}
        </RowGroup>
        <AppText role="secondary" tone="muted">
          {addIphoneAvailability}
        </AppText>
        <AppText role="secondary" tone="muted">
          {addIphoneNothingElse}
        </AppText>
      </View>
      {props.iphoneAppsAvailable ? (
        <View style={styles.section}>
          <PrimaryButton
            busy={adding}
            disabled={trimmed === ""}
            label={adding ? "Adding…" : `Add ${trimmed === "" ? "this iPhone" : trimmed}`}
            onPress={add}
          />
          {failure === null ? null : (
            <AppText role="secondary" tone="danger">
              {failure}
            </AppText>
          )}
        </View>
      ) : (
        <AppText role="secondary" tone="muted">
          {addIphoneNeedsUpdate(props.opensteer)}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  app: { gap: space[2], paddingHorizontal: space[16], paddingVertical: space[10] },
  content: { gap: space[20], paddingTop: space[16] },
  form: { gap: space[20] },
  section: { gap: space[8] },
});
