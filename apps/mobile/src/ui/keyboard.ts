import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Whether the keyboard is up, for a composer docked at the bottom: while it
 * is, the keyboard covers the home indicator and the dock gives up that inset.
 *
 * iOS says so as the keyboard starts to move, so the dock moves with it;
 * Android only once it has arrived.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
