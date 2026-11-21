import { OrganizationNameSchema, WorkPolicySchema } from "@opensteer/control-plane-protocol";
import { z } from "zod";
import { RunnerEnrollmentCredentialSchema } from "./runner.js";

export const workHomeEnrollmentPreviewRequiredReason = "work-home-enrollment-preview-required";
export const deviceEnrollmentPreviewPath = "/v1/runner/enrollment/preview";
export const DeviceEnrollmentPreviewRequestSchema = RunnerEnrollmentCredentialSchema.pick({
  enrollmentToken: true,
});
export const DeviceEnrollmentPreviewResponseSchema = z.object({
  organizationName: OrganizationNameSchema.optional(),
  devices: WorkPolicySchema.shape.devices.optional(),
});
export type DeviceEnrollmentPreview = z.infer<typeof DeviceEnrollmentPreviewResponseSchema>;
