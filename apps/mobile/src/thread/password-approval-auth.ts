import * as LocalAuthentication from "expo-local-authentication";

/** Every new Passwords decision needs a fresh OS device-owner confirmation. */
export async function authenticatePasswordApproval(): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: "Allow agents to use this saved login",
    cancelLabel: "Cancel",
    disableDeviceFallback: false,
  });
  if (!result.success && !["user_cancel", "app_cancel", "system_cancel"].includes(result.error))
    throw new Error(
      "Confirm with Face ID, fingerprint or your device passcode to allow this sign-in.",
    );
  return result.success;
}
