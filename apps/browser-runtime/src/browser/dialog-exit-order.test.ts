import { expect, it } from "vitest";
import {
  assertDialogExitOrder,
  type DialogExitObservation,
} from "./dialog-exit-order.test-support.js";

it("uses acknowledged phases when independent-channel timestamps invert, and refuses a real early release", () => {
  const events: DialogExitObservation[] = [
    { phase: "settling", at: 130067.42575 },
    { phase: "release-held", at: 130067.797041 },
    { phase: "answered", at: 130368 },
    { phase: "dialog-close-observed", at: 130369 },
    { phase: "release-finished", at: 132568 },
    { phase: "detach-sent", at: 132569 },
    { phase: "exited", at: 132570 },
  ];
  expect(() => assertDialogExitOrder(events)).not.toThrow();
  const earlyRelease = [...events];
  [earlyRelease[3], earlyRelease[4]] = [earlyRelease[4]!, earlyRelease[3]!];
  expect(() => assertDialogExitOrder(earlyRelease)).toThrow();
});
