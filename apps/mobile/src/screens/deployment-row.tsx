import { workspaceMonogram } from "@opensteer/client/host";
import type { DeploymentTone } from "../theme.js";
import type { DeploymentStatus } from "../client/deployment-rows.js";

const deploymentTones: readonly DeploymentTone[] = [
  "violet",
  "emerald",
  "amber",
  "sky",
  "rose",
  "teal",
];

/** A Deployment keeps the same identity colour everywhere without storing presentation state. */
export function deploymentTone(id: string): DeploymentTone {
  let hash = 2_166_136_261;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16_777_619);
  }
  return deploymentTones[(hash >>> 0) % deploymentTones.length]!;
}

export function deploymentInitial(name: string): string {
  return workspaceMonogram(name)[0] ?? "•";
}

export function statusTone(status: DeploymentStatus): "green" | "amber" | "red" | "muted" {
  switch (status) {
    case "connected":
      return "green";
    case "connecting":
    case "reconnecting":
    case "needs-sign-in":
      return "amber";
    case "signed-in":
    case "offline":
    case "unavailable":
      return "muted";
    case "unverified":
    case "update-required":
      return "red";
  }
}
