import type { EditingOperation } from "@opensteer/client/editing";
import { useRef, useState } from "react";
import { TextInput } from "react-native";

/** Old Hosts can insert plain text, but cannot verify keyboard replacements. */
export function LegacyInput({
  sendOperation,
  onDone,
}: {
  readonly sendOperation: (operation: EditingOperation) => boolean;
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const previous = useRef("");
  const backspace = useRef(false);
  const key = (key: string) => {
    for (const action of ["down", "up"] as const)
      if (!sendOperation({ kind: "key", keystroke: { action, key, code: key, modifiers: [] } })) {
        onDone();
        return;
      }
  };
  return (
    <TextInput
      accessibilityLabel="Type into the page"
      autoFocus
      submitBehavior="submit"
      autoCorrect={false}
      autoCapitalize="none"
      spellCheck={false}
      value={value}
      onBlur={onDone}
      style={{ flex: 1, minHeight: 44 }}
      onKeyPress={(event) => {
        backspace.current = event.nativeEvent.key === "Backspace" && previous.current.length > 0;
        if (event.nativeEvent.key === "Backspace") key("Backspace");
      }}
      onSubmitEditing={() => {
        key("Enter");
        backspace.current = false;
        previous.current = "";
        setValue("");
      }}
      onChangeText={(next) => {
        const deleted = backspace.current && previous.current.startsWith(next);
        backspace.current = false;
        if (deleted) {
          previous.current = next;
          setValue(next);
          return;
        }
        // No deletion/retyping projection: replacements require negotiated editing.
        if (!next.startsWith(previous.current)) {
          onDone();
          return;
        }
        const text = next.slice(previous.current.length);
        if (
          text &&
          !sendOperation({
            kind: "edit",
            edit: { contextId: "legacy", before: "", after: "", text },
          })
        ) {
          onDone();
          return;
        }
        previous.current = next;
        setValue(next);
      }}
    />
  );
}
