import { mockWorkPolicy } from "@opensteer/client/mock";
import { describe, expect, it } from "vitest";
import { joinWorkLine } from "./setup-view.js";

describe("a phone about to join", () => {
  it("says whose work Home it is joining, and may join", () => {
    expect(joinWorkLine(mockWorkPolicy("open"))).toEqual({
      work: "This device is joining a work Home owned by Northwind Logistics. Northwind Logistics will see that it joined, never what’s on it.",
      blocked: false,
    });
  });

  it("says its organization keeps other devices out, and Continue waits", () => {
    expect(joinWorkLine(mockWorkPolicy("strict"))).toEqual({
      work: "Northwind Logistics doesn’t allow other devices to join this work Home.",
      blocked: true,
    });
  });

  it("joins a personal Home with nothing new said, and waits while policy is unknown", () => {
    expect(joinWorkLine(null)).toEqual({ work: null, blocked: false });
    expect(joinWorkLine(undefined)).toEqual({ work: null, blocked: true });
  });
});
