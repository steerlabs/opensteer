import { z } from "zod";

const enrollmentToken = z.string().min(16).max(4_096).nullable();

/**
 * Private same-machine Host contract consumed by the Desktop supervisor. It
 * carries only what that supervisor will consume: the first-owner code and
 * the Main Runner's enrollment. Every other computer a Deployment supervises
 * for itself is enrolled through a token its supervisor minted and configured
 * the Host with, so the Host never records an enrollment nobody will redeem.
 */
export const LocalBootstrapSchema = z.strictObject({
  runnerEnrollmentToken: enrollmentToken,
  setupUrl: z.url().nullable(),
});
export type LocalBootstrap = z.infer<typeof LocalBootstrapSchema>;
