import { describe, expect, test } from "vitest";

import {
  buildLocalClausePool,
  type PathNode,
} from "../../packages/opensteer/src/runtimes/dom/index.js";

describe("DOM match policy parity", () => {
  test("does not append deferred attributes when primary match attributes exist", () => {
    const node: PathNode = {
      tag: "a",
      attrs: {
        "data-testid": "product-link",
        href: "/product/1",
      },
      position: {
        nthChild: 1,
        nthOfType: 1,
      },
      match: [],
    };

    expect(buildLocalClausePool(node)).toEqual([
      { kind: "attr", key: "data-testid", op: "exact" },
      { kind: "position", axis: "nthOfType" },
      { kind: "position", axis: "nthChild" },
    ]);
  });

  test("keeps deferred attributes when they are the only local selectors available", () => {
    const node: PathNode = {
      tag: "a",
      attrs: {
        href: "/product/1",
      },
      position: {
        nthChild: 1,
        nthOfType: 1,
      },
      match: [],
    };

    expect(buildLocalClausePool(node)).toEqual([
      { kind: "position", axis: "nthOfType" },
      { kind: "position", axis: "nthChild" },
      { kind: "attr", key: "href", op: "exact" },
    ]);
  });
});
