import { z } from "zod";

const reference = z.string().trim().min(1);
export const BuildSourceSchema = z.strictObject({
  url: z
    .url()
    .refine(
      (value) => ["https:", "http:"].includes(new URL(value).protocol),
      "Source URL must use HTTP(S)",
    ),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
});
const registry = reference.regex(/^[a-z0-9][a-z0-9.:-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/);
export const BuildImagesSchema = z.strictObject({
  registry: registry.optional(),
  cacheRegistry: registry.optional(),
});
export const DesktopSigningSchema = z.strictObject({
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  identity: reference,
  notarizationProfile: reference,
  keychain: z
    .string()
    .regex(/^\/.*\.keychain-db$/u)
    .optional(),
});
export const DesktopBuildSchema = z.strictObject({
  channel: z.enum(["beta", "stable"]),
  bundleId: z.string().regex(/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/),
  productName: reference,
  signing: DesktopSigningSchema.optional(),
});
export const MobileSigningSchema = z.strictObject({
  keystoreFile: reference,
  keyAlias: reference,
  storePasswordFile: reference,
  keyPasswordFile: reference,
});
export type BuildSource = z.infer<typeof BuildSourceSchema>;
export type BuildImages = z.infer<typeof BuildImagesSchema>;
export type DesktopSigning = z.infer<typeof DesktopSigningSchema>;
export type DesktopBuild = z.infer<typeof DesktopBuildSchema>;
export type MobileSigning = z.infer<typeof MobileSigningSchema>;
