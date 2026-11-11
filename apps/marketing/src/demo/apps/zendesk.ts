import "./zendesk.css";
import type { BrowserTab } from "./browser.js";

const path = (d: string): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${d}"/></svg>`;

const I = {
  home: path("M3.5 9 10 3.5 16.5 9v7.5h-4.5v-4.5h-4v4.5H3.5Z"),
  views: path("M3.5 4.5h13M3.5 8.5h13M3.5 12.5h13M3.5 16.5h8"),
  customers: path(
    "M8 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 17c.5-3.3 2.6-5 5.5-5s5 1.7 5.5 5M13 3.8a3 3 0 0 1 0 5.6M15.2 12.3c1.4.7 2.1 2.2 2.3 4.7",
  ),
  reporting: path("M3.5 16.5h13M6 13.5V9M10 13.5V5.5M14 13.5v-6"),
  admin: path(
    "M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM8.6 2.8h2.8l.4 2 1.5.9 1.9-.7 1.4 2.4-1.5 1.3v1.8l1.5 1.3-1.4 2.4-1.9-.7-1.5.9-.4 2H8.6l-.4-2-1.5-.9-1.9.7-1.4-2.4 1.5-1.3V9.1L3.4 7.8l1.4-2.4 1.9.7 1.5-.9Z",
  ),
  search: path("M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12.5 12.5 16.5 16.5"),
  bell: path(
    "M10 3a4.5 4.5 0 0 0-4.5 4.5V11L4 13.5h12L14.5 11V7.5A4.5 4.5 0 0 0 10 3ZM8.3 16a1.8 1.8 0 0 0 3.4 0",
  ),
  apps: path("M4 4h4v4H4ZM12 4h4v4h-4ZM4 12h4v4H4ZM12 12h4v4h-4Z"),
  help: path(
    "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM7.9 7.9a2.2 2.2 0 1 1 3 2c-.6.3-.9.7-.9 1.4M10 13.9v.1",
  ),
  plus: path("M10 5v10M5 10h10"),
  close: path("M6 6l8 8M14 6l-8 8"),
  caret: path("M6 8l4 4 4-4"),
  reply: path("M8 5 3.5 9.5 8 14M3.5 9.5H12a4.5 4.5 0 0 1 4.5 4.5v1"),
  format: path("M4.5 5.5V4h11v1.5M10 4v12M7.5 16h5"),
  emoji: path(
    "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM7.2 11.6a3.4 3.4 0 0 0 5.6 0M7.6 8.2v.1M12.4 8.2v.1",
  ),
  attach: path(
    "M14.5 9.5 9 15a3.2 3.2 0 0 1-4.5-4.5l6-6a2.1 2.1 0 0 1 3 3l-6 6a1 1 0 0 1-1.5-1.5L11 7",
  ),
  link: path(
    "M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1-1",
  ),
  macro: path("M11 2.5 4.5 11.5H10l-1 6 6.5-9H10Z"),
  user: path("M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 17c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5"),
  book: path(
    "M4 4.5h4.5A1.5 1.5 0 0 1 10 6v10a1.5 1.5 0 0 0-1.5-1.5H4ZM16 4.5h-4.5A1.5 1.5 0 0 0 10 6v10a1.5 1.5 0 0 1 1.5-1.5H16Z",
  ),
} as const;

const MARK = `<svg class="zd-mark" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 3.5h7l-7 8.5Z"/><path d="M10.5 3.5a3.5 3.5 0 0 0 7 0Z"/><path d="M2.5 16.5a3.5 3.5 0 0 1 7 0Z"/><path d="M17.5 8v8.5h-7Z"/></svg>`;

const RAIL = `<nav class="zd-rail"><b>${MARK}</b>${[
  I.home,
  I.views,
  I.customers,
  I.reporting,
  I.admin,
]
  .map((icon, index) => `<i${index === 1 ? ' class="is-on"' : ""}>${icon}</i>`)
  .join("")}<span class="zd-rail__me">AR</span></nav>`;

const TOP = `<header class="zd-top">
  <span class="zd-tab zd-tab--views">${I.views}Views</span>
  <span class="zd-tab zd-tab--ticket"><i class="zd-dot"></i><span><b>Charged twice for November</b><em>#4821</em></span>${I.close}</span>
  <span class="zd-add">${I.plus}Add</span>
  <span class="zd-top__end">${I.search}${I.bell}${I.help}${I.apps}<i class="zd-ava" style="--v:#8a6d5e">AR</i></span>
</header>`;

const row = (status: string, subject: string, requester: string, when: string, priority: string) =>
  `<span class="zd-badge zd-badge--${status.toLowerCase()}">${status}</span><span class="zd-subject">${subject}</span><span>${requester}</span><span>${when}</span><span>${priority}</span>`;

const LIST = `<div class="zd-list">
  <aside class="zd-views">
    <h6>Views</h6>
    <div class="is-on">Your unsolved tickets<span data-h="zd-count">5</span></div>
    <div>Unassigned tickets<span>2</span></div>
    <div>All unsolved tickets<span>14</span></div>
    <div>Recently updated<span>9</span></div>
    <div>Pending tickets<span>3</span></div>
    <div>Recently solved<span>21</span></div>
  </aside>
  <section class="zd-table">
    <h4>Your unsolved tickets</h4>
    <div class="zd-row zd-row--head"><span>Status</span><span>Subject</span><span>Requester</span><span>Requested</span><span>Priority</span></div>
    <div class="zd-row zd-row--new" data-h="zd-row">${row("New", "Charged twice for November", "Dana Whitfield", "Just now", "Urgent")}</div>
    <div class="zd-row">${row("Open", "Can't export the October report", "Theo Park", "32 min ago", "Normal")}</div>
    <div class="zd-row">${row("Open", "Add two seats to our plan", "Imani Brooks", "1 hour ago", "Normal")}</div>
    <div class="zd-row">${row("Pending", "SSO login loops back to sign-in", "Luis Ortega", "3 hours ago", "High")}</div>
    <div class="zd-row">${row("Open", "Invoice shows the wrong VAT number", "Greta Lind", "Yesterday", "Normal")}</div>
    <div class="zd-row">${row("Pending", "Webhook retries after a 200", "Sana Qureshi", "Yesterday", "Low")}</div>
  </section>
</div>`;

const select = (value: string): string =>
  `<div class="zd-field zd-field--select">${value}${I.caret}</div>`;

const TICKET = `<div class="zd-ticket">
  <aside class="zd-props">
    <label>Requester</label><div class="zd-field"><i class="zd-ava" style="--v:#3d7ac8">DW</i>Dana Whitfield</div>
    <label>Assignee<a>take it</a></label><div class="zd-field zd-field--select"><i class="zd-ava" style="--v:#8a6d5e">AR</i>Alex Rivera${I.caret}</div>
    <label>Tags</label><div class="zd-tags"><span>billing</span><span>enterprise</span><span>duplicate_charge</span></div>
    <div class="zd-pair"><div><label>Type</label>${select("Problem")}</div><div><label>Priority</label>${select("Urgent")}</div></div>
  </aside>
  <section class="zd-convo">
    <header class="zd-crumbs"><span>Northwind Traders</span><span>Dana Whitfield</span><span class="zd-crumbs__ticket"><b class="zd-badge zd-badge--open" data-h="zd-status">Open</b>Ticket #4821</span></header>
    <h4>Charged twice for November</h4>
    <div class="zd-thread">
      <article class="zd-msg"><i class="zd-ava" style="--v:#3d7ac8">DW</i><div><b>Dana Whitfield</b><time>Today 9:38 AM</time><p>Hi, our card was charged <mark>$480 twice on Nov 3</mark> for the same invoice. Can you sort it out today? Finance closes our books tomorrow.</p></div></article>
      <article class="zd-msg zd-msg--sent"><i class="zd-ava" style="--v:#8a6d5e">AR</i><div><b>Alex Rivera</b><time>Today 9:41 AM</time><p data-h="zd-sent"></p></div></article>
    </div>
    <div class="zd-composer">
      <div class="zd-composer__head"><span class="zd-channel">${I.reply}Public reply${I.caret}</span><span>To</span><em>Dana Whitfield</em><span class="zd-cc">CC</span></div>
      <p class="zd-composer__text" data-h="zd-reply"></p>
      <div class="zd-composer__tools">${[I.format, I.emoji, I.attach, I.link, I.macro].map((icon) => `<span>${icon}</span>`).join("")}</div>
    </div>
    <footer class="zd-foot"><span class="zd-macro">${I.macro}Apply macro${I.caret}</span><span class="zd-close">Close tab${I.caret}</span><span class="zd-split"><span class="zd-submit" data-h="zd-submit">Submit as <b>Solved</b></span><i>${I.caret}</i></span></footer>
  </section>
  <nav class="zd-context">${[I.user, I.book, I.apps].map((icon, index) => `<i${index === 0 ? ' class="is-on"' : ""}>${icon}</i>`).join("")}</nav>
</div>`;

export const zendesk: BrowserTab = {
  id: "zendesk",
  title: "Tickets · Zendesk",
  url: "riveraco.zendesk.com<em>/agent/tickets/4821</em>",
  mark: `<i class="br-fav" style="background:#03363d">z</i>`,
  page: `<div class="zd">${RAIL}<div class="zd-app">${TOP}<div class="zd-work">${LIST}${TICKET}</div></div></div>`,
};
