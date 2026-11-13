import { ActionSheetIOS, Alert, Platform } from "react-native";

export function confirmDestructive(input: {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  readonly onConfirm: () => void;
}): void {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        cancelButtonIndex: 1,
        destructiveButtonIndex: 0,
        message: input.message,
        options: [input.confirm, "Cancel"],
        title: input.title,
      },
      (index) => {
        if (index === 0) input.onConfirm();
      },
    );
    return;
  }
  Alert.alert(input.title, input.message, [
    { style: "cancel", text: "Cancel" },
    { onPress: input.onConfirm, style: "destructive", text: input.confirm },
  ]);
}
