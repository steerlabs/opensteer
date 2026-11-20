import { workHomeSeeView } from "@opensteer/client/host";
import { mockWorkPolicy } from "@opensteer/client/mock";
import { workAuditKindValues } from "@opensteer/control-plane-protocol";
import { describe, expect, it } from "vitest";
import { workHomePolicySections } from "./work-home-policy-sections.js";

describe("What your organization can see, on the phone", () => {
  it("says what it decided and its version, the records this Home sends, and what never leaves", () => {
    const sections = workHomePolicySections(workHomeSeeView(mockWorkPolicy("strict")));
    expect(sections.map(({ key }) => key)).toEqual(["lead", "decides", "sees", "records", "never"]);
    const decides = sections.find(({ key }) => key === "decides")!;
    expect(decides.title).toBe("What Northwind Logistics decides");
    expect(decides.rows.map((row) => ("detail" in row ? row.detail : null))).toEqual([
      "Supervised",
      "Not allowed",
      "Not allowed",
      "Only this Cloud Computer",
    ]);
    expect(decides.footer?.text).toBe("Version 3");
    expect(sections.find(({ key }) => key === "records")!.rows).toHaveLength(
      workAuditKindValues.length,
    );
    expect(sections.find(({ key }) => key === "never")!.title).toBe(
      "Northwind Logistics can never see",
    );
  });
});
