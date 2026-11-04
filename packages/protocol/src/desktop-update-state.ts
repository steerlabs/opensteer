import { z } from "zod";

export const DesktopUpdateChannelSchema = z.enum(["stable", "beta"]);
export type DesktopUpdateChannel = z.infer<typeof DesktopUpdateChannelSchema>;

export const DesktopUpdateStateSchema = z.object({
  /** `unavailable`: this copy cannot update itself, as outside Applications. */
  status: z.enum([
    "unavailable",
    "idle",
    "checking",
    "up-to-date",
    "ahead",
    "available",
    "downloading",
    "downloaded",
    "error",
  ]),
  reservedBy: z.enum(["local", "remote"]).nullable().optional(),
  channel: DesktopUpdateChannelSchema,
  latestVersion: z.string().min(1).max(64).nullable(),
  currentVersion: z.string().min(1).max(64),
  /** The newer version on offer, from `available` through `downloaded`, and after its download failed. */
  availableVersion: z.string().min(1).max(64).nullable(),
  /** Whole percent while `downloading`. */
  downloadPercent: z.number().int().min(0).max(100).nullable(),
  /** With `error`: whether the check or the download failed. */
  failed: z.enum(["check", "download"]).nullable(),
});
export type DesktopUpdateState = z.infer<typeof DesktopUpdateStateSchema>;

export function resolveDesktopAppBranding(version: string): {
  displayName: string;
  track: "beta" | "stable";
} {
  const track = version.endsWith("-insider") ? "beta" : "stable";
  return { displayName: track === "beta" ? "Opensteer (Beta)" : "Opensteer", track };
}
