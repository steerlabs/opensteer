import { z } from "zod";
export const journeySteps: Record<string, string> = {
  mount: "Mount, switch tabs and paint",
  geometry: "Resize, crop and native hit test",
  focus: "Agent CDP preserves another app's focus",
  clipboard: "Agent paste and menu chords cannot reach the Mac",
  editing: "Person AppKit editing chords",
  find: "Find and Escape",
  fullscreen: "Contained HTML fullscreen and Escape",
  download: "Visible native download feedback and overlay isolation",
  backgroundDialog: "Background dialog does not activate Opensteer",
  return: "Hide, return and reconnect",
  nativeFailure: "Failed native replacement shows unavailable without picture streaming",
  revoke: "Revoke authority and unmount synchronously",
};
export const passkeyJourneySteps = {
  "passkeys-notice": "Personal browser passkeys on a notice-only Mac",
  passkeys: "Personal browser passkey registration, sign-in, Continue and refusal",
};
export const JourneyResultSchema = z.object({
  status: z.enum(["PASS", "FAIL"]),
  steps: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["PASS", "FAIL"]),
      seconds: z.number().nonnegative(),
      error: z.string().optional(),
    }),
  ),
});
