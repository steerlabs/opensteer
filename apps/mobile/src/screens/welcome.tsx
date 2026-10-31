import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { color, material, controlFontScaleLimit, radius, space } from "../theme.js";
import { AppText, Notice } from "../ui/primitives.js";
import { accountDoorPresentation } from "./account-door.js";

export function Welcome(props: {
  readonly account: DesktopAccountAuthState["account"];
  readonly failure: string | null;
  readonly onAccount: () => void;
  readonly onPersonal: () => void;
  readonly onServer: () => void;
  readonly signingIn: boolean;
}): ReactNode {
  const account = accountDoorPresentation(props.account, props.signingIn);
  const unavailable = !props.account.available;
  const accountFailure =
    props.failure ??
    ((props.account.status === "error" || unavailable) && props.account.detail !== null
      ? account.description
      : null);

  return (
    <View style={styles.welcome}>
      <View accessibilityLabel="Opensteer" style={styles.mark}>
        <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="displayLarge" tone="ember">
          O
        </AppText>
      </View>
      <View style={styles.intro}>
        <AppText role="displayLarge" style={styles.centred}>
          Opensteer
        </AppText>
        <AppText numberOfLines={2} role="secondary" style={styles.sentence} tone="soft">
          {unavailable
            ? "Account sign-in is unavailable. Add a server by address or pair a computer instead."
            : "Steer the agents running on your computers and servers from your phone."}
        </AppText>
      </View>
      {accountFailure === null ? null : (
        <Notice detail={accountFailure} title="Opensteer sign-in did not finish" />
      )}
      {unavailable ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: props.signingIn, disabled: account.disabled }}
          disabled={account.disabled}
          onPress={props.onAccount}
          style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
        >
          {props.signingIn ? <ActivityIndicator color={color.inkOnEmber} /> : null}
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={2}
            role="action"
            style={{ color: color.inkOnEmber }}
          >
            {account.title}
          </AppText>
        </Pressable>
      )}
      <View style={styles.doors}>
        <WelcomeDoor label="Add a server by address" onPress={props.onServer} />
        <WelcomeDoor label="Pair a computer" onPress={props.onPersonal} />
      </View>
    </View>
  );
}

function WelcomeDoor(props: { readonly label: string; readonly onPress: () => void }): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => [styles.door, pressed && styles.doorPressed]}
    >
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={2}
        role="action"
        tone="ember"
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centred: { textAlign: "center" },
  door: {
    alignItems: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: space[12],
  },
  doorPressed: { ...material.quiet },
  doors: { alignItems: "stretch", gap: space[4] },
  intro: { alignItems: "center", gap: space[8] },
  mark: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.lg,
    height: 72,
    justifyContent: "center",
    width: 72,
  },
  primary: {
    ...material.accent,
    borderRadius: radius.full,
    width: "100%",
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: space[16],
    paddingVertical: space[4],
  },
  primaryPressed: { ...material.accentPressed },
  sentence: { maxWidth: 300, textAlign: "center" },
  welcome: {
    alignItems: "center",
    alignSelf: "center",
    gap: space[24],
    maxWidth: 360,
    paddingVertical: space[24],
    width: "100%",
  },
});
