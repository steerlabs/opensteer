import { useState, type ComponentProps, type ReactNode } from "react";
import { Alert, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { NativeMenu } from "../thread/composer-menu.js";
import { AddressText } from "./address-text.js";
import { useCopy } from "./copy-mark.js";

/**
 * An address that could once be selected and copied: drawn as `AddressText` draws it, which a
 * selection would copy wrong, so Copy in the platform's own menu gives the plain value instead.
 *
 * On iOS that menu is a SwiftUI host that takes its content's own size (`@expo/ui/community/menu`:
 * `Host` and `RNHostView`, both `matchContents`), so what it holds is laid out unconstrained, and
 * a long address would stay on one line past the screen's edge (build 9's walk). It is given, as
 * its own width, the width this component's container gives it, measured, so it wraps there.
 */
export function CopyableAddressText(
  props: ComponentProps<typeof AddressText> & {
    /** Where it stands among its neighbours: `{ flex: 1 }` beside a button in a row. */
    readonly layoutStyle?: StyleProp<ViewStyle>;
  },
): ReactNode {
  const { layoutStyle, ...text } = props;
  const [width, setWidth] = useState<number | null>(null);
  const { copy } = useCopy({
    onFailure: () => Alert.alert("Couldn’t copy", props.value),
  });
  return (
    <View
      onLayout={(event) => {
        const measured = event.nativeEvent.layout.width;
        setWidth((current) => (current === measured ? current : measured));
      }}
      style={[styles.room, layoutStyle]}
    >
      <NativeMenu
        accessibilityHint="Shows Copy"
        accessibilityLabel={props.value}
        options={[{ id: "copy", label: "Copy", onPress: () => void copy(props.value) }]}
      >
        {/* Unseen until its width is known: never a frame drawn past the edge. */}
        <View style={width === null ? styles.unmeasured : { width }}>
          <AddressText {...text} />
        </View>
      </NativeMenu>
    </View>
  );
}

const styles = StyleSheet.create({
  room: { alignSelf: "stretch", minWidth: 0 },
  unmeasured: { opacity: 0, width: 0 },
});
