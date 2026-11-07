import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import { Image, Platform, Pressable, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, radius, space } from "../theme.js";
import { useHostValue } from "../ui/mobile-client-context.js";
import { useMobileNotifications, usePushRegistration } from "../ui/notifications-context.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText, PrimaryButton } from "../ui/primitives.js";
import { useGutter } from "../ui/screen.js";

const selectConnected = (snapshot: HostSnapshot): boolean => snapshot.connection === "connected";

/**
 * Offers the notifications intro over Chat the first time this phone is
 * connected there and can still be asked. Chat is the one place every way of
 * reaching a computer lands, so it is asked from here and nowhere else.
 */
export function useNotificationsIntro(hostClient: HostClient | null): void {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const { intro } = useMobileNotifications();
  const { status } = usePushRegistration();
  const connected = useHostValue(hostClient, selectConnected, false);
  useEffect(() => {
    if (intro === null) return;
    let current = true;
    void intro.due({ connected, onChat: focused }).then((due) => {
      if (!due || !current || !navigation.isFocused()) return;
      void intro.presented();
      navigation.navigate("NotificationsIntro");
    });
    return () => {
      current = false;
    };
  }, [connected, focused, intro, navigation, status]);
}

/**
 * Why to allow notifications, before the system asks. iOS gets one button that
 * leads to its own prompt and leaves by the sheet's dismissal; Android offers
 * both answers, and asks only after Enable.
 */
export function NotificationsIntroScreen(): ReactNode {
  const navigation = useNavigation();
  const { registration } = useMobileNotifications();
  const insets = useContentInsets();
  const gutter = useGutter();
  const ios = Platform.OS === "ios";
  const enable = (): void => {
    // The system's prompt is its own window, so the sheet can leave as it opens.
    void registration.requestPermission().catch(() => undefined);
    navigation.goBack();
  };
  return (
    <View
      style={[
        styles.sheet,
        {
          paddingBottom: insets.bottom + space[16],
          paddingLeft: gutter + insets.left,
          paddingRight: gutter + insets.right,
        },
      ]}
    >
      <View style={styles.copy}>
        <AppText role="displayLarge" style={styles.centred}>
          Know when you’re needed
        </AppText>
        <AppText role="body" style={styles.centred} tone="soft">
          Get notified when an agent finishes or needs your answer.
        </AppText>
      </View>
      <NotificationPreview />
      <View style={styles.actions}>
        <PrimaryButton
          label={ios ? "Continue" : "Enable notifications"}
          onPress={enable}
          prominent
        />
        {ios ? (
          <AppText role="caption" style={styles.centred} tone="muted">
            Next, iOS asks to allow notifications.
          </AppText>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.notNow, pressed && styles.pressed]}
          >
            <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="action" tone="ember">
              Not now
            </AppText>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** What one arriving looks like: the app's icon at banner size, a task and its ask. */
function NotificationPreview(): ReactNode {
  return (
    <View
      accessibilityLabel="Example notification: Update the pricing page. Needs your answer."
      accessibilityRole="image"
      style={styles.preview}
    >
      <Image source={require("../../assets/icon.png") as number} style={styles.previewIcon} />
      <View style={styles.previewCopy}>
        <View style={styles.previewHead}>
          <AppText numberOfLines={1} role="secondaryMedium" style={styles.previewTitle}>
            Update the pricing page
          </AppText>
          <AppText role="caption" tone="muted">
            now
          </AppText>
        </View>
        <AppText numberOfLines={2} role="secondary" tone="soft">
          Needs your answer: publish the new prices today?
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space[12] },
  centred: { textAlign: "center" },
  copy: { gap: space[8] },
  notNow: {
    alignItems: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    minHeight: 44,
  },
  pressed: { backgroundColor: color.surfacePressed },
  preview: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.lg,
    flexDirection: "row",
    gap: space[10],
    padding: space[12],
  },
  previewCopy: { flex: 1, gap: space[2], minWidth: 0 },
  previewHead: { alignItems: "baseline", flexDirection: "row", gap: space[8] },
  previewIcon: { borderRadius: 8, height: 34, width: 34 },
  previewTitle: { flex: 1 },
  sheet: {
    backgroundColor: color.surfaceElevated,
    gap: space[24],
    paddingTop: space[32],
  },
});
