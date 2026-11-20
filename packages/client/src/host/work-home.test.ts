import { describe, expect, it } from "vitest";
import { mockWorkPolicy } from "../mock/mock-work-home.js";
import {
  workDeviceLimit,
  workEnrollNotice,
  workEnrollRefusal,
  workHomeMark,
  workHomeSeeView,
  workRecordWords,
} from "./work-home.js";
import { workAuditKindValues, workAuditRecordKinds } from "@opensteer/control-plane-protocol";

describe("a work Home, from inside it", () => {
  it("is marked with its organization; a personal Home is not marked at all", () => {
    expect(workHomeMark(mockWorkPolicy("strict"))).toEqual({
      organization: "Northwind Logistics",
      badge: "Work · Northwind Logistics",
      seeTitle: "What Northwind Logistics can see",
      navLabel: "Your organization",
    });
    expect(workHomeMark(null)).toBeNull();
    expect(workHomeMark(undefined)).toBeNull();
  });

  it("lists exactly the record kinds this Home says it sends, in its order", () => {
    const view = workHomeSeeView({
      ...mockWorkPolicy("open"),
      auditRecordKinds: ["stop", "connection.consent"],
    });
    expect(view.sees.records).toEqual(["Stop was pressed", "An agent was connected, and by whom"]);
    expect(view.decides.rows.map(({ value }) => value)).toEqual([
      "Auto",
      "Allowed",
      "Not allowed",
      "You may connect your own devices",
    ]);
    expect(view.decides.version).toBe("Version 7");
    expect(view.never.items).toContain("Screenshots");
    expect(view.never.items).toContain("Your personal Opensteer and your own computers");
  });

  it("has words for every record kind the Home can return, in the person's own voice", () => {
    for (const kind of workAuditKindValues) expect(workRecordWords(kind)).toMatch(/\S/u);
    expect(workRecordWords("owner.signed_in")).toBe("You signed in");
    expect(workRecordWords("owner.signed_out")).toBe("You signed out");
    // Only the person's words change; the organization's own file keeps its words.
    expect(workRecordWords("stop")).toBe(
      workAuditRecordKinds.find(({ kind }) => kind === "stop")!.words,
    );
    const said = workHomeSeeView(mockWorkPolicy("strict")).sees.records;
    expect(said).toHaveLength(workAuditKindValues.length);
    expect(said.some((words) => /the person/iu.test(words))).toBe(false);
  });

  it("keeps other devices out, or says whose Home they join, by the policy", () => {
    expect(workDeviceLimit(mockWorkPolicy("strict"))).toBe("Your organization doesn’t allow this");
    expect(workEnrollNotice(mockWorkPolicy("strict"))).toBeNull();
    expect(workEnrollRefusal(mockWorkPolicy("strict"))).toBe(
      "Northwind Logistics doesn’t allow other devices to join this work Home.",
    );
    expect(workEnrollRefusal(mockWorkPolicy("open"))).toBeNull();
    expect(workDeviceLimit(mockWorkPolicy("open"))).toBeNull();
    expect(workEnrollNotice(mockWorkPolicy("open"))).toBe(
      "This device is joining a work Home owned by Northwind Logistics. Northwind Logistics will see that it joined, never what’s on it.",
    );
    expect(workDeviceLimit(null)).toBeNull();
    expect(workEnrollNotice(null)).toBeNull();
  });
});
