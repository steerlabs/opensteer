import type { IphoneNativeObservation } from "@opensteer/protocol/iphone-bridge";
import { computerUseMaxElements, computerUseTreeMaxBytes } from "@opensteer/protocol";

export function phoneLabel(value: string, limit = 200): string {
  const points = Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim());
  return points.slice(0, limit).join("") + (points.length > limit ? "…" : "");
}

export type PhoneTreeTarget = {
  nodeId: string;
  frame: NonNullable<IphoneNativeObservation["nodes"][number]["frame"]>;
  secure: IphoneNativeObservation["nodes"][number]["secure"];
};

export function phoneTree(observation: IphoneNativeObservation, indexed = true) {
  const targets = new Map<number, PhoneTreeTarget>();
  const lines: string[] = [];
  let used = 0;
  let truncated = observation.coverage.truncated;
  const coverage = observation.coverage;
  const qualified = coverage.coordinateSpace === "qualified";
  const footer =
    `Accessibility ${coverage.status} (${coverage.reason}); ${coverage.missingFrames} missing frames, ${coverage.missingChildren} missing children.` +
    (!qualified
      ? " Element coordinates are unqualified; indexed targets are unavailable."
      : !indexed
        ? " Indexed targets are unavailable."
        : "");
  const closing = "Tree size limit reached; more elements are not shown.";
  const reserve = Buffer.byteLength(footer + "\n" + closing + "\n");
  const { width, height } = observation.geometry;
  for (const node of observation.nodes) {
    const frame = node.frame;
    const bounded =
      qualified &&
      frame &&
      frame.x >= 0 &&
      frame.y >= 0 &&
      frame.x + frame.width <= width &&
      frame.y + frame.height <= height
        ? frame
        : null;
    const index = bounded && indexed ? targets.size : undefined;
    const label = JSON.stringify(phoneLabel(node.label));
    const rect = bounded
      ? ` (${Math.floor(bounded.x)},${Math.floor(bounded.y)} ${Math.ceil(bounded.x + bounded.width) - Math.floor(bounded.x)}×${Math.ceil(bounded.y + bounded.height) - Math.floor(bounded.y)})`
      : "";
    const flags = [
      node.enabled === false ? "disabled" : "",
      node.focused === true ? "focused" : "",
      node.selected === true ? "selected" : "",
      node.editable === "yes" ? "editable" : "",
      node.secure === "yes" ? "secure" : "",
      node.source === "ocr" ? "ocr" : "",
    ].filter(Boolean);
    const line = `${"  ".repeat(node.depth)}${index === undefined ? "" : `[${index}] `}${node.role} ${label}${rect}${flags.length ? " " + flags.join(" ") : ""}`;
    const size = Buffer.byteLength(line) + 1;
    if (
      lines.length === computerUseMaxElements ||
      used + size + reserve > computerUseTreeMaxBytes
    ) {
      truncated = true;
      break;
    }
    if (index !== undefined && bounded)
      targets.set(index, { nodeId: node.nodeId, frame: bounded, secure: node.secure });
    lines.push(line);
    used += size;
  }
  const count = lines.length;
  if (truncated) lines.push(closing);
  lines.push(footer);
  return { tree: lines.join("\n"), elementCount: count, truncated, targets };
}
