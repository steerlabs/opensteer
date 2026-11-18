import { expect, it, vi } from "vitest";
import { Alert } from "react-native";
import { confirm, confirmDestructive } from "./confirm.js";

vi.mock("react-native", () => ({
  ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
}));

it.each([confirm, confirmDestructive])("$name lets Android dismiss the alert", (show) => {
  const onConfirm = vi.fn();
  show({
    title: "Remove account?",
    message: "Remove the saved sign-in.",
    confirm: "Remove",
    onConfirm,
  });

  const [, , buttons, options] = vi.mocked(Alert.alert).mock.calls.at(-1)!;
  expect(options?.cancelable).toBe(true);
  options?.onDismiss?.();
  buttons?.[0]?.onPress?.();
  expect(onConfirm).not.toHaveBeenCalled();
  buttons?.[1]?.onPress?.();
  expect(onConfirm).toHaveBeenCalledOnce();
});
