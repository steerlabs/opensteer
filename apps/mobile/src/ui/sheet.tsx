import { useRef, type ReactNode } from "react";
import {
  type HostInstance,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { color, controlFontScaleLimit, space, touchTarget } from "../theme.js";
import { AppText } from "./primitives.js";

/**
 * Forms use a full-screen native modal so the keyboard and the pinned action
 * share screen coordinates. Fabric measures a page sheet from its own origin,
 * which cannot be combined with the keyboard's screen coordinates. Short
 * reviews without a footer remain dismissible page sheets.
 *
 * Close only dismisses. The footer holds the form's explicit commit action.
 */
export function Sheet(props: {
  readonly children: ReactNode;
  /** Pinned under the body and above the keyboard: the action the sheet is for. */
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly title: string;
}): ReactNode {
  return (
    <Modal
      allowSwipeDismissal={props.footer === undefined}
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle={props.footer === undefined ? "pageSheet" : "fullScreen"}
      visible={props.open}
    >
      <SafeAreaProvider>
        <SheetFrame {...props} />
      </SafeAreaProvider>
    </Modal>
  );
}

function SheetFrame(props: {
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly title: string;
}): ReactNode {
  const hasFooter = props.footer !== undefined;
  const content = useRef<HostInstance>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const scrollY = useRef(0);
  const viewport = useRef(0);

  // The viewport just shrank for the keyboard: keep the field being typed into
  // in it, clear of the footer that now sits where the field was.
  const revealFocusedInput = (): void => {
    const input = TextInput.State.currentlyFocusedInput();
    const body = content.current;
    if (input === null || input === undefined || body === null) return;
    input.measureLayout(
      body,
      (_x, y, _width, height) => {
        const bottom = y + height + space[16];
        if (bottom > scrollY.current + viewport.current) {
          scroll.current?.scrollTo({ y: bottom - viewport.current });
        } else if (y < scrollY.current) {
          scroll.current?.scrollTo({ y: Math.max(0, y - space[16]) });
        }
      },
      () => {},
    );
  };

  return (
    <View style={styles.modal}>
      <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.frame}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          enabled={props.open && hasFooter}
          style={styles.column}
        >
          <View style={styles.head}>
            <View style={styles.headSide} />
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="title"
              style={styles.title}
            >
              {props.title}
            </AppText>
            <Pressable
              accessibilityLabel={`Close ${props.title}`}
              accessibilityRole="button"
              hitSlop={space[8]}
              onPress={props.onClose}
              style={[styles.headSide, styles.close]}
            >
              <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="action" tone="ember">
                Close
              </AppText>
            </Pressable>
          </View>
          <ScrollView
            automaticallyAdjustKeyboardInsets={!hasFooter}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={revealFocusedInput}
            onFocus={revealFocusedInput}
            onLayout={(event) => {
              viewport.current = event.nativeEvent.layout.height;
              if (hasFooter) revealFocusedInput();
            }}
            onScroll={(event) => {
              scrollY.current = event.nativeEvent.contentOffset.y;
            }}
            ref={scroll}
            scrollEventThrottle={16}
            style={styles.scroll}
          >
            <View ref={content} style={styles.body}>
              {props.children}
            </View>
          </ScrollView>
          {hasFooter ? <View style={styles.footer}>{props.footer}</View> : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignSelf: "center", flex: 1, maxWidth: 720, width: "100%" },
  body: { gap: space[2], paddingBottom: space[24] },
  close: {
    alignItems: "flex-end",
    justifyContent: "center",
    paddingLeft: space[12],
  },
  footer: {
    backgroundColor: color.surfaceElevated,
    borderColor: color.lineStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  frame: { flex: 1 },
  head: {
    alignItems: "center",
    flexDirection: "row",
    paddingHorizontal: space[16],
    paddingVertical: space[8],
  },
  headSide: { justifyContent: "center", minHeight: touchTarget, minWidth: 64 },
  modal: { backgroundColor: color.surfaceElevated, flex: 1 },
  scroll: { flex: 1 },
  title: { flex: 1, textAlign: "center" },
});
