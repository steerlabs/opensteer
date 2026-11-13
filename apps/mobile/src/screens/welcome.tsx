import { useHeaderHeight } from "@react-navigation/elements";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import {
  AppText,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SectionLabel,
} from "../ui/primitives.js";
import { Screen, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import {
  shareMacLink,
  welcomeCopy,
  welcomePresentation,
  welcomeSentence,
  type WelcomeProps,
} from "./welcome-model.js";

/**
 * The first run on Android: the same form as iOS's, drawn with this app's own
 * rows, because the Android app has no native form to borrow.
 */
export function Welcome(props: WelcomeProps): ReactNode {
  const view = welcomePresentation(props);
  const column = useReadingColumn();
  const headerHeight = useHeaderHeight();
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.content, column, { paddingTop: headerHeight }]}
        contentInsetAdjustmentBehavior="never"
      >
        <View style={styles.intro}>
          <Symbol name="laptopcomputer.and.iphone" size={40} tint={color.ember} />
          <AppText role="displayLarge" style={styles.centred}>
            {welcomeCopy.title}
          </AppText>
          <AppText role="body" style={styles.centred} tone="soft">
            {welcomeSentence(thisPhoneNoun)}
          </AppText>
        </View>
        {view.failure === null ? null : (
          <Notice detail={view.failure} title={welcomeCopy.failureTitle} />
        )}
        {view.macLink === null ? null : (
          <PrimaryButton
            label={welcomeCopy.mac}
            onPress={() => shareMacLink(view.macLink!)}
            prominent
          />
        )}
        {view.macLink === null ? (
          <PrimaryButton label={welcomeCopy.scan} onPress={props.onScan} prominent />
        ) : (
          <SecondaryButton label={welcomeCopy.scan} onPress={props.onScan} />
        )}
        <View style={styles.section}>
          <SectionLabel>{welcomeCopy.otherWays}</SectionLabel>
          <RowGroup>
            {[
              view.signedInAs === null ? null : (
                <View key="identity" style={styles.row}>
                  <AppText role="body" style={styles.rowLabel}>
                    {view.signedInAs}
                  </AppText>
                </View>
              ),
              view.account === null ? null : (
                <WelcomeRow
                  busy={props.signingIn}
                  disabled={view.account.disabled}
                  key="account"
                  label={view.account.label}
                  onPress={props.onAccount}
                />
              ),
              <WelcomeRow key="address" label={welcomeCopy.address} onPress={props.onAddress} />,
            ]}
          </RowGroup>
          <AppText role="caption" tone="muted">
            {view.footer}
          </AppText>
        </View>
      </ScrollView>
    </Screen>
  );
}

function WelcomeRow(props: {
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy ?? false, disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <AppText role="body" style={styles.rowLabel} tone={props.disabled ? "muted" : "default"}>
        {props.label}
      </AppText>
      {props.busy === true ? (
        <ActivityIndicator color={color.muted} />
      ) : (
        <Symbol name="chevron.right" size={13} tint={color.mutedDim} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centred: { textAlign: "center" },
  content: { flexGrow: 1, gap: space[24], justifyContent: "center", paddingBottom: space[24] },
  intro: { alignItems: "center", gap: space[8] },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 50,
    paddingHorizontal: space[16],
  },
  rowLabel: { flex: 1 },
  section: { gap: space[8] },
});
