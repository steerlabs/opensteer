import { StyleSheet, View } from "react-native";
import { SecondaryButton } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { space } from "../theme.js";

export type BrowserPageMenuAction =
  "copy" | "cut" | "paste" | "select-all" | "copy-link" | "open-link";

/** Only runtime-attributed contextmenu facts can open this sheet. */
export function BrowserPageMenu({
  menu,
  sensitive,
  basicInput = false,
  onAction,
  onDismiss,
}: {
  readonly menu: {
    readonly editable: boolean;
    readonly selection: boolean;
    readonly linkUrl?: string | undefined;
  };
  readonly sensitive: boolean;
  readonly basicInput?: boolean;
  readonly onAction: (action: BrowserPageMenuAction) => void;
  readonly onDismiss: () => void;
}) {
  const items: { label: string; action: BrowserPageMenuAction; disabled?: boolean }[] = [
    ...(basicInput
      ? []
      : [
          {
            label: "Cut",
            action: "cut" as const,
            disabled: sensitive || !menu.editable || !menu.selection,
          },
        ]),
    { label: "Copy", action: "copy", disabled: sensitive || !menu.selection },
    { label: "Paste", action: "paste", disabled: !menu.editable },
    { label: "Select all", action: "select-all" },
    ...(menu.linkUrl
      ? [
          { label: "Copy link address", action: "copy-link" as const },
          { label: "Open link in new tab", action: "open-link" as const },
        ]
      : []),
  ];
  return (
    <Sheet open title="Page actions" onClose={onDismiss}>
      <View style={styles.actions}>
        {items.map((item) => (
          <SecondaryButton
            key={item.action}
            label={item.label}
            disabled={item.disabled === true}
            onPress={() => onAction(item.action)}
          />
        ))}
      </View>
    </Sheet>
  );
}
const styles = StyleSheet.create({ actions: { gap: space[12], padding: space[16] } });
