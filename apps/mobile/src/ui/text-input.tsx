import type { ReactNode, Ref } from "react";
import {
  TextInput as NativeTextInput,
  type TextInputInstance,
  type TextInputProps,
} from "react-native";
import { interact } from "../voice/interaction.js";

/**
 * The app's text field. Focusing it and every edit are the person's own step,
 * so a screen presentation captured before cannot land after: a hardware
 * keyboard raises no software keyboard, and the field may already be left by
 * the time the presentation arrives.
 */
export function TextInput({
  onChangeText,
  onFocus,
  ...props
}: TextInputProps & { readonly ref?: Ref<TextInputInstance> }): ReactNode {
  return (
    <NativeTextInput
      {...props}
      onChangeText={(text) => {
        interact();
        onChangeText?.(text);
      }}
      onFocus={(event) => {
        interact();
        onFocus?.(event);
      }}
    />
  );
}
