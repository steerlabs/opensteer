import { HeaderHeightContext } from "@react-navigation/elements";
import { useIsFocused } from "@react-navigation/native";
import { useContext, useEffect } from "react";
import { makeMutable } from "react-native-reanimated";

/**
 * The bottom edge of the focused screen's header, for chrome drawn outside the
 * navigator (the connection pill) that cannot measure it. A shared value, so a
 * large title collapsing under a scroll moves that chrome without a render.
 * Zero is unknown: the screen has no header of the navigator's.
 */
export const headerBottom = makeMutable(0);

/** Rendered in each screen's layout: the focused screen says where its header ends. */
export function PublishHeaderClearance(): null {
  const height = useContext(HeaderHeightContext);
  const focused = useIsFocused();
  useEffect(() => {
    if (focused) headerBottom.value = height ?? 0;
  }, [focused, height]);
  return null;
}
