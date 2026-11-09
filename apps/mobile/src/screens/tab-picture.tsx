import type { BrowserTabPicture } from "@opensteer/client/host";
import { useMemo, type ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import { color, radius } from "../theme.js";

/**
 * A tab's kept picture in a list row's mark: the top of the page, cropped to
 * the mark, decoded at the size it is drawn. A still, with nothing on it that
 * says live; it never fades in, so it reads as the picture it is.
 */
export function TabPicture(props: {
  readonly picture: BrowserTabPicture;
  readonly size: number;
}): ReactNode {
  const { picture, size } = props;
  const uri = picture.uri;
  const source = useMemo(() => ({ uri }), [uri]);
  const tall = picture.height >= picture.width;
  const drawn = tall
    ? { width: size, height: (size * picture.height) / picture.width }
    : { width: (size * picture.width) / picture.height, height: size };
  return (
    <View style={[styles.frame, { width: size, height: size }]}>
      <Image
        accessibilityIgnoresInvertColors
        fadeDuration={0}
        resizeMethod="resize"
        source={source}
        style={drawn}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.line,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
});
