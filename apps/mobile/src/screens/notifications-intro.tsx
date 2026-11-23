import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, controlFontScaleLimit, displayFontScaleLimit, radius, space } from "../theme.js";
import { useHostValue } from "../ui/mobile-client-context.js";
import { useMobileNotifications, usePushRegistration } from "../ui/notifications-context.js";
import { useContentInsets } from "../ui/pane.js";
import { AppText, PrimaryButton } from "../ui/primitives.js";
import { useGutter } from "../ui/screen.js";

const selectConnected = (snapshot: HostSnapshot): boolean => snapshot.connection === "connected";

/**
 * Offers the notifications intro over Home the first time this phone is
 * connected there and can still be asked. Home is the one place every way of
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
    void intro.due({ connected, onHome: focused }).then((due) => {
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
 *
 * The sheet sizes to what it holds, but never past the screen: at the largest
 * text sizes its words scroll and its answers stay in view below them. Its title
 * grows as far as `displayFontScaleLimit`, where its widest word still fits the
 * narrowest phone, so it never breaks inside a word.
 */
export function NotificationsIntroScreen(): ReactNode {
  const navigation = useNavigation();
  const { registration } = useMobileNotifications();
  const insets = useContentInsets();
  const gutter = useGutter();
  const window = useWindowDimensions();
  // The sheet stands below the status bar, with a margin above it, as iOS and Android draw one.
  const tallest = window.height - useSafeAreaInsets().top - space[16];
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
          maxHeight: tallest,
          paddingBottom: insets.bottom + space[16],
          paddingLeft: gutter + insets.left,
          paddingRight: gutter + insets.right,
        },
      ]}
    >
      <ScrollView contentContainerStyle={styles.words} style={styles.scroll}>
        <View style={styles.copy}>
          <AppText
            maxFontSizeMultiplier={displayFontScaleLimit}
            role="displayLarge"
            style={styles.centred}
          >
            Know when you’re needed
          </AppText>
          <AppText role="body" style={styles.centred} tone="soft">
            Get notified when an agent finishes or needs your answer.
          </AppText>
        </View>
        <NotificationPreview />
      </ScrollView>
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

/**
 * What one arriving looks like: the app's icon at banner size, a task and its ask. A picture of a
 * banner (read as one image), its words grow only as far as the title's.
 */
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
          <AppText
            maxFontSizeMultiplier={displayFontScaleLimit}
            numberOfLines={1}
            role="secondaryMedium"
            style={styles.previewTitle}
          >
            Update the pricing page
          </AppText>
          <AppText maxFontSizeMultiplier={displayFontScaleLimit} role="caption" tone="muted">
            now
          </AppText>
        </View>
        <AppText
          maxFontSizeMultiplier={displayFontScaleLimit}
          numberOfLines={2}
          role="secondary"
          tone="soft"
        >
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
  scroll: { flexGrow: 0, flexShrink: 1 },
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
  words: { gap: space[24] },
});
