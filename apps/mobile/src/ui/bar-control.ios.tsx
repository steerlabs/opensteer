import type { ReactNode } from "react";
import { ScrollToTopGuard } from "react-native-screens/experimental";

/**
 * A control of ours that a screen puts in its native navigation bar.
 *
 * From iOS 27 on iPhone (26 on iPad) a tap on the bar scrolls the screen's
 * content to its top. A Pressable's tap is React Native's, which UIKit cannot
 * see (react-native#56061), so a tap on a React control in the bar did both.
 * The guard claims the tap for the control; native bar items need none.
 */
export function BarControl(props: { readonly children: ReactNode }): ReactNode {
  return <ScrollToTopGuard>{props.children}</ScrollToTopGuard>;
}
