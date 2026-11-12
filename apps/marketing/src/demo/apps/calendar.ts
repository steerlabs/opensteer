import "./calendar.css";
import type { BrowserTab } from "./browser.js";

const DAYS = [
  ["SUN", "8"],
  ["MON", "9"],
  ["TUE", "10"],
  ["WED", "11"],
  ["THU", "12"],
  ["FRI", "13"],
  ["SAT", "14"],
] as const;

const event = (day: number, top: number, height: number, title: string, time: string): string =>
  `<span class="gc-event" style="left:calc(${day} * 100% / 7 + 2px);top:${top}px;height:${height}px"><b>${title}</b>${time}</span>`;

/** Google Calendar's week view, signed in. */
export const calendar: BrowserTab = {
  id: "calendar",
  title: "Google Calendar - Week of November 8",
  url: "calendar.google.com<em>/calendar/u/0/r/week</em>",
  mark: `<i class="br-fav" style="background:#fff;color:#1a73e8">10</i>`,
  page: `<div class="gc">
  <header class="gc-top"><b>Calendar</b><span class="gc-btn">Today</span><h4>November 2026</h4><span class="gc-btn gc-btn--end">Week</span><i>AR</i></header>
  <div class="gc-days"><span></span>${DAYS.map(([name, date]) => `<span${date === "10" ? ' class="is-today"' : ""}>${name}<b>${date}</b></span>`).join("")}</div>
  <div class="gc-grid">
    <div class="gc-hours">${["9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM"].map((hour) => `<span>${hour}</span>`).join("")}</div>
    <div class="gc-week">${event(1, 48, 46, "Pipeline review", "10 – 11am")}${event(2, 0, 46, "Support standup", "9 – 10am")}${event(2, 144, 70, "Northwind renewal", "12 – 1:30pm")}${event(4, 96, 46, "Acme: walk through quote", "11am – 12pm")}${event(5, 48, 46, "Ship 2.4", "10 – 11am")}</div>
  </div>
</div>`,
};
