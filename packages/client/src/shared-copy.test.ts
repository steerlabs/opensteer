import { expect, it } from "vitest";
import { cloudComputerCopy } from "./computers/cloud-computer-copy.js";
import { devicesCopy } from "./computers/devices-copy.js";
import { menuBarCopy } from "./computers/menu-bar-copy.js";
import { agentWorkCopy } from "./host/agent-work-copy.js";
import { connectedAgentsCopy } from "./host/connected-agents-copy.js";

it("uses the approved names in shared customer copy", () => {
  const violations: string[] = [];
  for (const copy of [
    cloudComputerCopy,
    devicesCopy,
    menuBarCopy,
    agentWorkCopy,
    connectedAgentsCopy,
  ]) {
    for (const [id, value] of Object.entries(copy)) {
      if (
        /\bOpensteer Account\b/u.test(value) ||
        /\b(?:external agents?|outside agents?|live tabs)\b/iu.test(value)
      )
        violations.push(`${id}: ${value}`);
    }
  }
  expect(violations).toEqual([]);
});
