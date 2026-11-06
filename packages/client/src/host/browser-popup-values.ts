import type { BrowserPopupState } from "@opensteer/protocol";
export type CalendarPopup = Extract<
  BrowserPopupState,
  { kind: "date" | "time" | "datetime-local" | "month" | "week" }
>;
const leap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
function days(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400),
    a = y - era * 400;
  return (
    era * 146097 +
    a * 365 +
    Math.floor(a / 4) -
    Math.floor(a / 100) +
    Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) +
    d -
    1 -
    719468
  );
}
function date(s: string): number | null {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const y = Number(match[1]),
    m = Number(match[2]),
    d = Number(match[3]);
  if (
    y < 1 ||
    !Number.isSafeInteger(y) ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!
  )
    return null;
  const n = days(y, m, d) * 86400000;
  return Number.isSafeInteger(n) ? n : null;
}
function time(s: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(s);
  if (!match) return null;
  const h = Number(match[1]),
    m = Number(match[2]),
    sec = Number(match[3] ?? 0);
  if (h > 23 || m > 59 || sec > 59) return null;
  return ((h * 60 + m) * 60 + sec) * 1000 + Number((match[4] ?? "").padEnd(3, "0"));
}
/** HTML calendar values never pass through the viewer's timezone or an instant. */
export function browserCalendarNumber(kind: CalendarPopup["kind"], value: string): number | null {
  if (kind === "date") return date(value);
  if (kind === "time") return time(value);
  if (kind === "datetime-local") {
    const pieces = value.split("T");
    if (pieces.length !== 2) return null;
    const d = date(pieces[0]!),
      t = time(pieces[1]!);
    return d === null || t === null ? null : d + t;
  }
  if (kind === "month") {
    const m = /^(\d{4,})-(\d{2})$/.exec(value);
    if (!m) return null;
    const y = Number(m[1]),
      month = Number(m[2]);
    return y >= 1 && Number.isSafeInteger(y) && month >= 1 && month <= 12
      ? (y - 1970) * 12 + month - 1
      : null;
  }
  const m = /^(\d{4,})-W(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]),
    week = Number(m[2]);
  if (year < 1 || !Number.isSafeInteger(year) || week < 1 || week > 53) return null;
  const monday = (y: number) => {
    const jan4 = days(y, 1, 4);
    return jan4 - ((((jan4 + 3) % 7) + 7) % 7);
  };
  const start = monday(year) + (week - 1) * 7;
  if (start >= monday(year + 1)) return null;
  return start * 86400000;
}
export function browserPopupValueError(state: BrowserPopupState, value: string): string | null {
  if (state.kind === "select" || state.kind === "datalist") return "Choose an option.";
  if (state.kind === "color")
    return value.length && new TextEncoder().encode(value).byteLength <= 4096
      ? null
      : "Enter a CSS color.";
  if (value === "") return state.required ? "A value is required." : null;
  const n = browserCalendarNumber(state.kind, value);
  if (n === null) return "Enter a complete calendar value.";
  const wrapping = state.kind === "time" && state.minimum > state.maximum;
  // Native sends the input type's own range for an absent bound; only non-finite values become
  // zero, so both bounds being zero means there is no range to check.
  if (
    (state.minimum !== 0 || state.maximum !== 0) &&
    (wrapping ? n < state.minimum && n > state.maximum : n < state.minimum || n > state.maximum)
  )
    return "Choose a value within the allowed range.";
  if (!state.stepAny) {
    const quotient = (n - state.stepBase) / state.step;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-7)
      return "Choose a value on the allowed step.";
  }
  return null;
}
export function browserPopupHtmlStep(state: CalendarPopup): string {
  return state.stepAny
    ? "any"
    : String(
        state.step /
          (state.kind === "time" || state.kind === "datetime-local"
            ? 1000
            : state.kind === "date"
              ? 86400000
              : state.kind === "week"
                ? 604800000
                : 1),
      );
}
export const browserPopupTitle = (state: BrowserPopupState): string =>
  state.kind === "select" || state.kind === "datalist"
    ? "Choose an option"
    : state.kind === "color"
      ? "Choose a color"
      : state.kind === "time"
        ? "Choose a time"
        : state.kind === "month"
          ? "Choose a month"
          : state.kind === "week"
            ? "Choose a week"
            : "Choose a date";
