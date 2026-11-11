import "./hubspot.css";
import type { BrowserTab } from "./browser.js";

const line = (path: string): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICONS = {
  note: "M5 3.5h7l3 3v10H5ZM12 3.5v3h3M7.5 10h5M7.5 13h3.5",
  email: "M3 5h14v10H3ZM3.5 5.5 10 11l6.5-5.5",
  call: "M6 3.5 8 7 6.5 8.5c1 2 3 4 5 5L13 12l3.5 2-1 2.5C9 16.5 3.5 11 3.5 4.5Z",
  task: "M4 4h12v12H4ZM7 10l2 2 4-4.5",
  meeting: "M3.5 5h13v11h-13ZM3.5 8.5h13M7 3v3.5M13 3v3.5",
  search: "M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12.5 12.5 17 17",
  bell: "M10 3a4.5 4.5 0 0 0-4.5 4.5V11L4 14h12l-1.5-3V7.5A4.5 4.5 0 0 0 10 3ZM8.3 16.5a1.8 1.8 0 0 0 3.4 0",
  gear: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6",
  contacts: "M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 17c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5",
  deals: "M3 6h14v10H3ZM7.5 6V4h5v2M3 10.5h14",
  chart: "M4 16V9M8 16V5M12 16v-5M16 16V7",
  inbox: "M3 11h4l1.5 2.5h3L13 11h4M5 4h10l2 7v5H3v-5Z",
  grid: "M4 4h4v4H4ZM12 4h4v4h-4ZM4 12h4v4H4ZM12 12h4v4h-4Z",
} as const;

const SPROCKET = `<svg class="hs-sprocket" viewBox="0 0 20 20" aria-hidden="true"><circle cx="12" cy="12" r="3.6" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 8.4V4.6M9.4 14.6l-3.6 2.6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="3.6" r="1.8" fill="currentColor"/><circle cx="5" cy="17.6" r="1.6" fill="currentColor"/></svg>`;

const STAGES = ["Renewal due", "Proposal sent", "Negotiation", "Closed won", "Closed lost"];

const RAIL = `<nav class="hs-rail"><b>${SPROCKET}</b>${[ICONS.grid, ICONS.contacts, ICONS.deals, ICONS.inbox, ICONS.chart].map((path, index) => `<i${index === 2 ? ' class="is-on"' : ""}>${line(path)}</i>`).join("")}</nav>`;

const TOP = `<header class="hs-top"><span class="hs-search">${line(ICONS.search)}Search HubSpot</span><span class="hs-top__end">${line(ICONS.bell)}${line(ICONS.gear)}<i class="hs-ava hs-ava--me">AR</i></span></header>`;

const PIPE = `<div class="hs-pipe">
  <span class="hs-pipe__name">Renewals pipeline</span>
  <div class="hs-pipe__track" data-h="hs-pipe">${STAGES.map((stage, index) => `<span class="hs-step hs-step--${index}">${stage}</span>`).join("")}<i class="hs-pipe__now"></i></div>
</div>`;

const action = (name: keyof typeof ICONS, label: string, hook = ""): string =>
  `<span class="hs-act"${hook ? ` data-h="${hook}"` : ""}><i>${line(ICONS[name])}</i>${label}</span>`;

const LEFT = `<aside class="hs-left">
  <div class="hs-ident"><i class="hs-deal">${line(ICONS.deals)}</i><h4>Acme Corp — 2027 renewal</h4></div>
  <p class="hs-sum">Amount: <b class="hs-sum__amount" data-h="hs-head-amount">$36,000</b></p>
  <div class="hs-acts">${action("note", "Note", "hs-note-btn")}${action("email", "Email")}${action("call", "Call")}${action("task", "Task")}${action("meeting", "Meet")}</div>
  <section class="hs-about">
    <h6>About this deal</h6>
    <label>Deal owner</label><div class="hs-val">Alex Rivera</div>
    <label>Amount</label><div class="hs-input" data-h="hs-amount-field">$<span class="hs-typed" data-h="hs-amount">36,000</span></div>
    <label>Close date</label><div class="hs-val">12/15/2026</div>
    <label>Deal stage</label><div class="hs-input hs-select" data-h="hs-stage-field"><span data-h="hs-stage">Renewal due</span><svg viewBox="0 0 10 6" aria-hidden="true"><path d="m1 1 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>
    <div class="hs-menu">${STAGES.map((stage, index) => `<span${index === 1 ? ' data-h="hs-opt"' : ""}${index === 0 ? ' class="is-on"' : ""}>${stage}</span>`).join("")}</div>
  </section>
</aside>`;

const entry = (kind: keyof typeof ICONS, who: string, when: string, body: string): string =>
  `<article class="hs-entry"><header><i>${line(ICONS[kind])}</i><b>${who}</b><time>${when}</time></header><p>${body}</p></article>`;

export const HUBSPOT_NOTE =
  "Team grew to 120. Repriced: 120 seats × $400 = $48,000 (was 90 seats, $36,000).";

const MID = `<main class="hs-mid">
  <div class="hs-tabs"><span>Overview</span><span class="is-on">Activities</span><span>Intelligence</span></div>
  <div class="hs-editor" data-h="hs-editor">
    <header><b>Note</b><span>×</span></header>
    <p class="hs-typed" data-h="hs-note"></p>
    <footer><span class="hs-btn" data-h="hs-save">Save note</span></footer>
  </div>
  <p class="hs-month">November 2026</p>
  <div class="hs-feed">
    <article class="hs-entry hs-entry--new"><header><i>${line(ICONS.note)}</i><b>Note by Alex Rivera</b><time>Just now</time></header><p>${HUBSPOT_NOTE}</p></article>
    ${entry("email", "Email to Priya Raman", "Nov 2", "Acme's plan renews Dec 31. Want to set up time to plan 2027?")}
    ${entry("call", "Call with Priya Raman", "Oct 14", "New VP Ops since September. Wants the renewal proposal before budgets lock.")}
    ${entry("deals", "Deal created", "Oct 2", "Renewal of Acme's 90-seat Team plan, $36,000 a year.")}
  </div>
</main>`;

const RIGHT = `<aside class="hs-right">
  <section class="hs-assoc"><h6>Contacts (1)</h6><div class="hs-person"><i class="hs-ava">PR</i><div><a>Priya Raman</a><span>VP Operations</span><span>priya@acme.example</span></div></div></section>
  <section class="hs-assoc"><h6>Companies (1)</h6><div class="hs-person"><i class="hs-ava hs-ava--co">A</i><div><a>Acme Corp</a><span>acme.example</span><span>Austin, TX</span></div></div></section>
  <section class="hs-assoc"><h6>Line items (1)</h6><div class="hs-item"><b>Team plan, annual</b><span><span data-h="hs-qty">90</span> × $400 / seat</span></div></section>
</aside>`;

export const hubspot: BrowserTab = {
  id: "hubspot",
  title: "Acme Corp — 2027 renewal | HubSpot",
  url: "app.hubspot.com<em>/contacts/4471023/record/0-3/18264530011</em>",
  mark: `<i class="br-fav" style="background:#ff5c35">${SPROCKET}</i>`,
  page: `<div class="hs">${RAIL}<div class="hs-app">${TOP}${PIPE}<div class="hs-cols">${LEFT}${MID}${RIGHT}</div></div></div>`,
};
