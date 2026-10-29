import { z } from "zod";

/**
 * A bundle identifier, measured the way the Mac that resolves it measures one.
 *
 * A NUL is refused outright: it cannot survive the C string LaunchServices
 * looks the app up with, so an identifier carrying one names a different app
 * there than it does here.
 */
export const ComputerAppBundleIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("\0"), "A bundle identifier cannot contain a null byte");

/** An Apple Developer team identifier, which is fixed at ten of its alphabet. */
export const ComputerAppTeamIdSchema = z.string().regex(/^[A-Z0-9]{10}$/u);

/**
 * Which app one computer-app connection names.
 *
 * The bundle identifier is the durable key; the process id and the window are
 * never part of it, so an app that quits and relaunches is still the app the
 * owner approved. The signing team is the one fact that separates two builds
 * claiming the same identifier, and `null` is the truthful answer for an
 * unsigned app rather than a reason to refuse it. The display name is the name
 * at approval time, kept so a person reads the name they approved even after
 * the app is renamed on disk.
 *
 * It lives here rather than in the protocol package because both
 * `@opensteer/integration-core` and `@opensteer/protocol` describe it and only
 * this direction of the dependency exists.
 */
export const ComputerAppIdentitySchema = z.strictObject({
  bundleId: ComputerAppBundleIdSchema,
  displayName: z.string().min(1).max(255),
  teamId: ComputerAppTeamIdSchema.nullable(),
});
export const ComputerAppIdentityViewSchema = z.object(ComputerAppIdentitySchema.shape);
export type ComputerAppIdentity = z.infer<typeof ComputerAppIdentitySchema>;
