import { expect, it } from "vitest";
import {
  browserCalendarNumber,
  browserPopupHtmlStep,
  browserPopupValueError,
} from "./browser-popup-values.js";
it("keeps calendar values independent of timezone, validates ISO weeks and uses Chromium's step units", () => {
  expect(browserCalendarNumber("date", "1970-01-01")).toBe(0);
  expect(browserCalendarNumber("date", "2023-02-29")).toBeNull();
  expect(browserCalendarNumber("date", "2024-02-29")).not.toBeNull();
  expect(browserCalendarNumber("week", "1970-W01")).toBe(-259200000);
  expect(browserCalendarNumber("week", "2020-W53")).not.toBeNull();
  expect(browserCalendarNumber("week", "2021-W53")).toBeNull();
  expect(browserCalendarNumber("month", "1970-02")).toBe(1);
  expect(browserCalendarNumber("time", "01:59:59.123")).toBe(7199123);
  expect(
    browserCalendarNumber("datetime-local", "2024-03-10T02:30")! -
      browserCalendarNumber("datetime-local", "2024-03-10T01:30")!,
  ).toBe(3600000);
  const state = {
    kind: "time" as const,
    items: [],
    rtl: false,
    value: "23:00",
    minimum: 22 * 3600000,
    maximum: 2 * 3600000,
    step: 500,
    stepBase: 0,
    stepAny: false,
    required: true,
  };
  expect(browserPopupHtmlStep(state)).toBe("0.5");
  expect(browserPopupValueError(state, "23:00")).toBeNull();
  expect(browserPopupValueError(state, "01:00")).toBeNull();
  expect(browserPopupValueError(state, "12:00")).toBeTruthy();
  expect(browserPopupValueError(state, "")).toBeTruthy();
});
