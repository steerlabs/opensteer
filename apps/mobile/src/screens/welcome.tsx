import { useHeaderHeight } from "@react-navigation/elements";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import {
  AppText,
  DisplayTitle,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SectionLabel,
} from "../ui/primitives.js";
import { Screen, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import {
  keylessWelcomeCopy,
  shareMacLink,
  welcomeCopy,
  welcomePresentation,
  type WelcomeProps,
} from "./welcome-model.js";
import { AddressText } from "../ui/address-text.js";

/**
 * The first run on Android: the same form as iOS's, drawn with this app's own
 * rows, because the Android app has no native form to borrow.
 */
export function Welcome(props: WelcomeProps): ReactNode {
  const view = welcomePresentation(props);
  const column = useReadingColumn();
  const headerHeight = useHeaderHeight();
  // On the door and on "where", the other ways in wait behind one small link.
  const [otherWays, setOtherWays] = useState(false);
  const keyless = view.mode === "keyless";
  const otherRows = keyless
    ? [<WelcomeRow key="address" label={keylessWelcomeCopy.address} onPress={props.onAddress} />]
    : [
        <WelcomeRow
          detail={welcomeCopy.scanDetail}
          key="scan"
          label={welcomeCopy.scan}
          onPress={props.onScan}
        />,
        <WelcomeRow
          detail={welcomeCopy.addressDetail}
          key="address"
          label={welcomeCopy.address}
          onPress={props.onAddress}
        />,
      ];
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.content, column, { paddingTop: headerHeight }]}
        contentInsetAdjustmentBehavior="never"
      >
        <View style={styles.intro}>
          <Symbol name="laptopcomputer.and.iphone" size={40} tint={color.ember} />
          <DisplayTitle style={styles.centred}>{view.title}</DisplayTitle>
          <AppText role="body" style={styles.centred} tone="soft">
            {view.sentence(thisPhoneNoun)}
          </AppText>
        </View>
        {view.failure === null ? null : (
          <AppText role="secondary" style={styles.centred} tone="danger">
            {view.failure}
          </AppText>
        )}
        {/* The Opensteer account finds a Home on a Mac or a Cloud Computer, so it leads. */}
        {view.account === null ? null : (
          <PrimaryButton
            busy={props.signingIn}
            disabled={view.account.disabled}
            label={view.account.label}
            onPress={props.onAccount}
            prominent
          />
        )}
        {keyless ? (
          <>
            {view.macLink === null ? null : (
              <PrimaryButton
                label={welcomeCopy.mac}
                onPress={() => shareMacLink(view.macLink!)}
                prominent
              />
            )}
            {view.macLink === null ? (
              <PrimaryButton label={keylessWelcomeCopy.scan} onPress={props.onScan} prominent />
            ) : (
              <SecondaryButton label={keylessWelcomeCopy.scan} onPress={props.onScan} />
            )}
          </>
        ) : null}
        {view.mode === "where" ? (
          <>
            {view.signedInAs === null ? null : (
              <AddressText
                role="secondary"
                style={styles.centred}
                tone="muted"
                value={view.signedInAs}
              />
            )}
            <View style={styles.section}>
              <SectionLabel>{welcomeCopy.onMac}</SectionLabel>
              <AppText role="secondary" tone="soft">
                {welcomeCopy.onMacDetail}
              </AppText>
              {view.macLink === null ? null : (
                <SecondaryButton
                  label={welcomeCopy.mac}
                  onPress={() => shareMacLink(view.macLink!)}
                />
              )}
            </View>
            {view.cloud === null ? null : (
              <View style={styles.section}>
                <SectionLabel>{welcomeCopy.onCloud}</SectionLabel>
                <AppText role="secondary" tone="soft">
                  {view.cloud.price === null
                    ? view.cloud.detail
                    : `${view.cloud.price}. ${view.cloud.detail}`}
                </AppText>
                {view.cloud.address === null ? null : (
                  <RowGroup>
                    {[
                      <View key="address" style={[styles.row, styles.rowText]}>
                        <AddressText
                          role="body"
                          style={styles.rowLabel}
                          value={view.cloud.address}
                        />
                      </View>,
                      <WelcomeRow
                        key="copy"
                        label={props.cloudCopied ? welcomeCopy.copied : welcomeCopy.copy}
                        onPress={() => props.onCopyCloudAddress?.(view.cloud!.address!)}
                      />,
                    ]}
                  </RowGroup>
                )}
              </View>
            )}
          </>
        ) : null}
        <View style={styles.section}>
          {keyless || otherWays ? (
            <>
              <SectionLabel>{welcomeCopy.otherWays}</SectionLabel>
              <RowGroup>{otherRows}</RowGroup>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setOtherWays(true)}
              style={styles.link}
            >
              <AppText role="secondaryMedium" tone="soft">
                {welcomeCopy.otherWays}
              </AppText>
            </Pressable>
          )}
          {view.footer === null ? null : (
            <AppText role="caption" tone="muted">
              {view.footer}
            </AppText>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function WelcomeRow(props: {
  readonly busy?: boolean;
  readonly detail?: string;
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
      <View style={styles.rowLabel}>
        <AppText role="body" tone={props.disabled ? "muted" : "default"}>
          {props.label}
        </AppText>
        {props.detail === undefined ? null : (
          <AppText role="caption" tone="muted">
            {props.detail}
          </AppText>
        )}
      </View>
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
  // A link is still a touch: at least 44 points tall.
  link: {
    alignSelf: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: space[8],
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 50,
    paddingHorizontal: space[16],
  },
  rowLabel: { flex: 1 },
  // A row of text that may wrap to several lines keeps clear of the rows beside it.
  rowText: { paddingVertical: space[12] },
  section: { gap: space[8] },
});
