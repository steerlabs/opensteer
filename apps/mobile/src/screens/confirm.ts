import { ActionSheetIOS, Alert, Platform } from "react-native";

interface Confirmation {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  readonly onConfirm: () => void;
}

export function confirm(input: Confirmation): void {
  confirmAlert(input, false);
}

export function confirmDestructive(input: Confirmation): void {
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
  confirmAlert(input, true);
}

function confirmAlert(input: Confirmation, destructive: boolean): void {
  Alert.alert(
    input.title,
    input.message,
    [
      { style: "cancel", text: "Cancel" },
      {
        onPress: input.onConfirm,
        text: input.confirm,
        ...(destructive ? { style: "destructive" } : {}),
      },
    ],
    { cancelable: true },
  );
}
