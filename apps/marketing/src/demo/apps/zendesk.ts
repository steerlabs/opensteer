import "./zendesk.css";
import type { BrowserTab } from "./browser.js";

const row = (status: string, subject: string, requester: string, when: string, priority: string) =>
  `<span class="zd-badge zd-badge--${status.toLowerCase()}">${status}</span><span class="zd-subject">${subject}</span><span>${requester}</span><span>${when}</span><span>${priority}</span>`;

const RAIL = `<nav class="zd-rail"><b>z</b><i class="is-on"></i><i></i><i></i><i></i></nav>`;

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

const TICKET = `<div class="zd-ticket">
  <aside class="zd-props">
    <label>Requester</label><div class="zd-field"><i class="zd-ava" style="--v:#3d7ac8">DW</i>Dana Whitfield</div>
    <label>Assignee</label><div class="zd-field"><i class="zd-ava" style="--v:#8a6d5e">AR</i>Alex Rivera</div>
    <label>Tags</label><div class="zd-tags"><span>billing</span><span>enterprise</span><span>duplicate_charge</span></div>
    <label>Type</label><div class="zd-field">Problem</div>
    <label>Priority</label><div class="zd-field">Urgent</div>
  </aside>
  <section class="zd-convo">
    <header class="zd-crumbs"><span>Northwind Traders</span><span>Dana Whitfield</span><span class="zd-crumbs__ticket"><b class="zd-badge zd-badge--open" data-h="zd-status">Open</b>Ticket #4821</span></header>
    <h4>Charged twice for November</h4>
    <div class="zd-thread">
      <article class="zd-msg"><i class="zd-ava" style="--v:#3d7ac8">DW</i><div><b>Dana Whitfield</b><time>Today 9:38 AM</time><p>Hi, our card was charged <mark>$480 twice on Nov 3</mark> for the same invoice. Can you sort it out today? Finance closes our books tomorrow.</p></div></article>
      <article class="zd-msg zd-msg--sent"><i class="zd-ava" style="--v:#8a6d5e">AR</i><div><b>Alex Rivera</b><time>Today 9:41 AM</time><p data-h="zd-sent"></p></div></article>
    </div>
    <div class="zd-composer">
      <div class="zd-composer__head"><b>Public reply</b><span>To</span><em>Dana Whitfield</em></div>
      <p class="zd-composer__text" data-h="zd-reply"></p>
      <div class="zd-composer__tools"><i></i><i></i><i></i><i></i><i></i></div>
    </div>
    <footer class="zd-foot"><span>Apply macro</span><span class="zd-submit" data-h="zd-submit">Submit as <b>Solved</b></span></footer>
  </section>
</div>`;

export const zendesk: BrowserTab = {
  id: "zendesk",
  title: "Tickets · Zendesk",
  url: "riveraco.zendesk.com<em>/agent/tickets/4821</em>",
  mark: `<i class="br-fav" style="background:#03363d">z</i>`,
  page: `<div class="zd">${RAIL}${LIST}${TICKET}</div>`,
};
