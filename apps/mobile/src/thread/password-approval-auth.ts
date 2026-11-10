import * as LocalAuthentication from "expo-local-authentication";

const purposes = {
  login: {
    prompt: "Allow agents to use this saved login",
    refused: "allow this saved credential",
  },
  card: {
    prompt: "Allow agents to use this saved card",
    refused: "allow this saved credential",
  },
  fill: { prompt: "Fill your saved login", refused: "fill your saved login" },
} as const;

/** Every new Passwords decision, and every fill the Mac has not yet confirmed, needs a fresh OS device-owner confirmation. */
export async function authenticatePasswordApproval(
  purpose: keyof typeof purposes = "login",
): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: purposes[purpose].prompt,
    cancelLabel: "Cancel",
    disableDeviceFallback: false,
  });
  if (!result.success && !["user_cancel", "app_cancel", "system_cancel"].includes(result.error))
    throw new Error(
      `Confirm with Face ID, fingerprint or your device passcode to ${purposes[purpose].refused}.`,
    );
  return result.success;
}
