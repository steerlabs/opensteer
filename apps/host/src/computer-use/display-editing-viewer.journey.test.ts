import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runDisplayEditingJourney } from "./display-editing-viewer.test-support.js";

// Failure inventory: exact operation wire, Host projection, private copy/results,
// baseline phone input, negotiated Mac acquire and give-back, all socket cleanup.
it("qualifies the viewer editing wire through real Host display sockets", async () => {
  const cases = await runDisplayEditingJourney(
    process.env.OPENSTEER_DISPLAY_EDITING_EVIDENCE_DIR ??
      join(tmpdir(), "opensteer-display-editing-host-journey"),
  );
  expect(cases).toHaveLength(6);
  expect(cases.filter((item) => !item.passed)).toEqual([]);
}, 30000);
