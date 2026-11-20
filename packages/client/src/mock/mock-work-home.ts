import { workAuditKindValues, type EffectiveWorkPolicy } from "@opensteer/control-plane-protocol";

/**
 * A work Home a preview opens on (`?mock-work`): `strict` is an organization's default ceiling
 * (Supervised, no Tasks, no Everything, its Cloud Computer only); `open` lets the person add
 * devices, give Tasks and go up to Auto. A personal Home is the preview without it.
 */
export const mockWorkHomeScenes = ["strict", "open"] as const;
export type MockWorkHomeScene = (typeof mockWorkHomeScenes)[number];

export function mockWorkPolicy(scene: MockWorkHomeScene): EffectiveWorkPolicy {
  return {
    organizationName: "Northwind Logistics",
    appliedRevision: scene === "strict" ? 3 : 7,
    externalMaxMode: scene === "strict" ? "approval-required" : "auto",
    allowEverything: false,
    allowTasks: scene === "open",
    devices: scene === "strict" ? "cloud-computer-only" : "assignee-may-enroll",
    auditRecordKinds: [...workAuditKindValues],
  };
}
