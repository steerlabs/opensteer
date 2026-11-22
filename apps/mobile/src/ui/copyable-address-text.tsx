import type { ComponentProps, ReactNode } from "react";
import { Alert } from "react-native";
import { NativeMenu } from "../thread/composer-menu.js";
import { AddressText } from "./address-text.js";
import { useCopy } from "./copy-mark.js";

/**
 * An address that could once be selected and copied: drawn as `AddressText` draws it, which a
 * selection would copy wrong, so Copy in the platform's own menu gives the plain value instead.
 */
export function CopyableAddressText(props: ComponentProps<typeof AddressText>): ReactNode {
  const { copy } = useCopy({
    onFailure: () => Alert.alert("Couldn’t copy", props.value),
  });
  return (
    <NativeMenu
      accessibilityHint="Shows Copy"
      accessibilityLabel={props.value}
      options={[{ id: "copy", label: "Copy", onPress: () => void copy(props.value) }]}
    >
      <AddressText {...props} />
    </NativeMenu>
  );
}
