import { expect, it } from "vitest";
import { poolReportsForPage } from "./personal-resources.js";

it("puts a pooled browser's report only on the placement page that carries its Runner", () => {
  const pools = [{ runnerId: "rnr_cloud", phase: "running" }];
  // The page the cloud computer is on carries its report.
  expect(poolReportsForPage(pools, [{ id: "rnr_mac" }, { id: "rnr_cloud" }])).toEqual(pools);
  // A page of other Runners carries none, so a reader never sees a report twice or apart.
  expect(poolReportsForPage(pools, [{ id: "rnr_mac" }, { id: "rnr_phone" }])).toEqual([]);
  expect(poolReportsForPage(pools, [])).toEqual([]);
});
