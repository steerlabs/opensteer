import type { IphoneNativeObservation } from "@opensteer/protocol/iphone-bridge";
import { computerUseTreeMaxBytes } from "@opensteer/protocol";

export function phoneLabel(value: string, limit = 200): string {
  const points = Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim());
  return points.slice(0, limit).join("") + (points.length > limit ? "…" : "");
}

export function phoneTree(observation: IphoneNativeObservation) {
  const lines: string[] = [];
  let used = 0;
  let truncated = observation.coverage.truncated;
  const coverage = observation.coverage;
  const footer = `Accessibility ${coverage.status} (${coverage.reason}); ${coverage.missingFrames} missing frames, ${coverage.missingChildren} missing children. Element coordinates are unqualified; indexed targets are unavailable.`;
  const closing = "Tree size limit reached; more elements are not shown.";
  const reserve = Buffer.byteLength(footer + "\n" + closing + "\n");
  for (const node of observation.nodes) {
    const label = JSON.stringify(phoneLabel(node.label));
    // Native AX frames are unqualified, so neither rectangles nor indices are actionable.
    const line = `${"  ".repeat(node.depth)}${node.role} ${label}${node.enabled === false ? " disabled" : ""}${node.focused === true ? " focused" : ""}${node.selected === true ? " selected" : ""}`;
    const size = Buffer.byteLength(line) + 1;
    if (lines.length === 1500 || used + size + reserve > computerUseTreeMaxBytes) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += size;
  }
  const count = lines.length;
  if (truncated) lines.push(closing);
  lines.push(footer);
  return { tree: lines.join("\n"), elementCount: count, truncated };
}
