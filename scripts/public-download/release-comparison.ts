import { z } from "zod";
import { journeyMetadata, numericVersion } from "./evidence.js";
export const signedComponent = z.object({
  path: z.string(),
  requirement: z.string().min(1),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/u),
  identifier: z.string().min(1),
  hardenedRuntime: z.boolean(),
  entitlements: z.record(z.string(), z.unknown()),
});
export const releaseInspection = z.object({
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  channel: z.enum(["stable", "beta"]),
  version: numericVersion,
  bundleVersion: numericVersion,
  bundleId: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  components: z.array(signedComponent).nonempty(),
  assessment: z.object({
    status: z.literal(0),
    output: z
      .string()
      .regex(/accepted/u)
      .regex(/source=Notarized Developer ID/u),
  }),
  staple: z.object({ status: z.literal(0), output: z.string() }),
});
export const releaseComparison = z
  .object({ metadata: journeyMetadata, ci: releaseInspection, local: releaseInspection })
  .superRefine((x, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    for (const key of ["revision", "channel", "version", "bundleVersion", "bundleId"] as const)
      if (x.ci[key] !== x.local[key]) fail(`Different ${key}`);
    const expectedId =
      x.ci.channel === "stable" ? "com.opensteer.opensteer" : "com.steerlabs.opensteer.beta";
    if (x.ci.bundleId !== expectedId) fail("Unexpected channel bundle ID");
    if (x.ci.version !== x.ci.bundleVersion) fail("Bundle versions differ");
    const ordered = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(ordered)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, ordered(item)]),
            )
          : value;
    for (const inspection of [x.ci, x.local]) {
      if (!inspection.components.some((c) => c.path === "." && c.hardenedRuntime))
        fail("Missing hardened main signature");
      if (new Set(inspection.components.map((c) => c.path)).size !== inspection.components.length)
        fail("Duplicate signed component");
      for (const c of inspection.components)
        if (c.teamId !== x.metadata.expectedTeamId) fail(`Unexpected team: ${c.path}`);
    }
    const components = (inspection: z.infer<typeof releaseInspection>) =>
      ordered([...inspection.components].sort((a, b) => a.path.localeCompare(b.path)));
    if (JSON.stringify(components(x.ci)) !== JSON.stringify(components(x.local)))
      fail("Designated requirements, identities, runtime flags or entitlements differ");
  });
