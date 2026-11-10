import { aiCompanies, aiCompanyNames, genericAiCompany } from "@opensteer/client/ai-sharing";
import type { HostClient } from "@opensteer/client/host";
import type { IntegrationAccess } from "@opensteer/client/integrations";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { SheetBarButton } from "../ui/sheet-bar.js";
import { controlFontScaleLimit, space, touchTarget } from "../theme.js";
import { useHostValue, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Field, PrimaryButton, RowGroup, SectionLabel, Toggle } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { useIphoneApps, useIphoneAppsState } from "./context.js";
import type { IphoneAppId } from "../platform/iphone-apps.js";
import { IphoneAppRow } from "./app-row.js";
import { iphonePermissionOf, type IphoneAppsController } from "./controller.js";
import {
  addIphoneAfterRestart,
  addIphoneButton,
  addIphoneDraft,
  addIphoneFailureText,
  addIphoneFootnote,
  addIphoneIntro,
  addIphoneNameHint,
  addIphoneNeedsUpdate,
  iphoneAppIds,
  iphoneAppName,
  iphoneAppSummary,
  iphoneDefaultAccess,
  iphoneLevelLabel,
  iphoneLevels,
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
        <View style={styles.bar}>
          <View style={styles.barSide} />
          <View accessibilityRole="header" style={styles.barTitle}>
            <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="title">
              {`Add this ${thisPhoneNoun}`}
            </AppText>
          </View>
          <SheetBarButton icon="xmark" label="Cancel" onPress={() => navigation.goBack()} />
        </View>
        {row === undefined || hostClient === null ? (
          <AppText role="secondary" tone="muted">
            {row === undefined
              ? "This deployment is no longer on this phone."
              : `Open ${row.name} to add this ${thisPhoneNoun} to it.`}
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
 * The iPhone's name, then a switch for each app this build can share, then
 * Add. Switching an app or choosing its level is a draft: the screen lists
 * every app and level Add turns on, so the one tap on Add is their review.
 * Once added, iOS is asked about each app in turn on the iPhone's page.
 */
export function AddIphoneForm(props: {
  readonly controller: IphoneAppsController;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly iphoneAppsAvailable: boolean;
  readonly onAdded: (runnerId: string) => void;
  readonly opensteer: string;
}): ReactNode {
  const companies = useHostValue(
    props.hostClient,
    (snapshot) => aiCompanyNames(aiCompanies(snapshot)),
    genericAiCompany,
  );
  const state = useIphoneAppsState(props.controller);
  const [name, setName] = useState(() => props.controller.getState().snapshot.deviceName);
  const [draft, setDraft] = useState<Readonly<Partial<Record<IphoneAppId, IntegrationAccess>>>>(
    () =>
      Object.fromEntries(
        iphoneAppIds.flatMap((app) => {
          const access = addIphoneDraft(app);
          return access === null ? [] : [[app, access]];
        }),
      ),
  );
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
  // Only apps this build can share are offered; the phone's page says why the others aren't.
  const apps = iphoneAppIds.filter((app) => iphonePermissionOf(state.snapshot, app) !== null);
  // Removal on this phone has not finished erasing its browser, which only a restart completes.
  const erasing = state.snapshot.pendingErasure === true;
  const chosen = apps.flatMap((app) => {
    const access = draft[app];
    return access === undefined ? [] : [{ access, app }];
  });

  const add = (): void => {
    if (adding || erasing || trimmed === "") return;
    setFailure(null);
    void props.controller
      .add({
        deploymentId: props.deploymentId,
        hostClient: props.hostClient,
        iphoneAppsAvailable: props.iphoneAppsAvailable,
        name: trimmed,
      })
      .then((outcome) => {
        if (outcome.kind === "added") {
          // The controller outlives this screen, so the apps go on turning on
          // while the iPhone's page shows each one.
          if (chosen.length > 0) {
            void props.controller.share({ apps: chosen, hostClient: props.hostClient });
          }
          if (mounted.current) props.onAdded(outcome.runnerId);
        } else if (outcome.kind === "failed" && mounted.current) {
          setFailure(addIphoneFailureText(outcome.failure, props.opensteer, thisPhoneNoun));
        }
      });
  };

  const choose = (app: IphoneAppId, access: IntegrationAccess | null): void => {
    void Haptics.selectionAsync();
    setDraft((current) => {
      const next = { ...current };
      if (access === null) delete next[app];
      else next[app] = access;
      return next;
    });
  };

  return (
    <View style={styles.form}>
      <AppText role="body" tone="soft">
        {addIphoneIntro(props.opensteer, apps.length > 0, thisPhoneNoun)}
      </AppText>
      <Field
        hint={addIphoneNameHint}
        input={{
          autoCapitalize: "words",
          autoCorrect: false,
          editable: !adding && !erasing,
          maxLength: 120,
          onChangeText: setName,
          returnKeyType: "done",
          value: name,
        }}
        label="Name"
      />
      {apps.length === 0 ? null : (
        <View style={styles.section}>
          <SectionLabel>Share</SectionLabel>
          <RowGroup>
            {apps.map((app) => {
              const access = draft[app] ?? null;
              const levels =
                access === null
                  ? []
                  : iphoneLevels({ app, current: access, definition: null, here: true });
              const appName = iphoneAppName(app);
              return (
                <IphoneAppRow
                  app={app}
                  disabledReason={adding ? "Wait while this iPhone is added." : null}
                  key={app}
                  levels={levels}
                  line={
                    access !== null && levels.length > 0
                      ? iphoneLevelLabel(null, access)
                      : iphoneAppSummary(app, access ?? iphoneDefaultAccess(app, null))
                  }
                  name={appName}
                  onLevel={(level) => choose(app, level.access)}
                  tone="muted"
                  trailing={
                    <Toggle
                      accessibilityLabel={`Share ${appName}`}
                      disabled={adding}
                      onChange={(on) => choose(app, on ? iphoneDefaultAccess(app, null) : null)}
                      value={access !== null}
                    />
                  }
                />
              );
            })}
          </RowGroup>
          <AppText role="caption" tone="muted">
            {addIphoneFootnote(props.opensteer, companies)}
          </AppText>
        </View>
      )}
      {props.iphoneAppsAvailable ? (
        <View style={styles.section}>
          <PrimaryButton
            busy={adding}
            disabled={trimmed === "" || erasing}
            label={addIphoneButton(trimmed, chosen.length, thisPhoneNoun)}
            onPress={add}
          />
          {failure === null ? null : (
            <AppText role="secondary" tone="danger">
              {failure}
            </AppText>
          )}
          {erasing ? (
            <AppText role="secondary" tone="muted">
              {addIphoneAfterRestart}
            </AppText>
          ) : null}
        </View>
      ) : (
        <AppText role="secondary" tone="muted">
          {addIphoneNeedsUpdate(props.opensteer, thisPhoneNoun)}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { alignItems: "center", flexDirection: "row", minHeight: touchTarget },
  barSide: { width: touchTarget },
  barTitle: { alignItems: "center", flex: 1, minWidth: 0 },
  content: { gap: space[20], paddingTop: space[16] },
  form: { gap: space[20] },
  section: { gap: space[8] },
});
