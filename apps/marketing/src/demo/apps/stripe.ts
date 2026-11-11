import "./stripe.css";
import type { BrowserTab } from "./browser.js";

const payment = (hook: string, date: string, invoice: string, extra = ""): string =>
  `<div class="st-row${extra}" data-h="${hook}"><b>$480.00</b><span class="st-cur">USD</span><span class="st-status"><i class="st-badge st-badge--ok">Succeeded ✓</i><i class="st-badge st-badge--back">Refunded ↩</i><i class="st-flag">Duplicate</i></span><span>${invoice}</span><span>${date}</span><span class="st-more">···</span></div>`;

export const stripe: BrowserTab = {
  id: "stripe",
  title: "Northwind Traders – Stripe",
  url: "dashboard.stripe.com<em>/customers/cus_Qn4Northwind</em>",
  mark: `<i class="br-fav" style="background:#635bff">S</i>`,
  page: `<div class="st">
  <aside class="st-side">
    <div class="st-account" data-h="st-account"><i>R</i><span>Rivera &amp; Co.</span></div>
    <nav><span>Home</span><span>Balances</span><span>Transactions</span><span class="is-on">Customers</span><span>Product catalog</span></nav>
    <h6>Products</h6>
    <nav><span>Billing</span><span>Invoicing</span><span>Reporting</span></nav>
  </aside>
  <main class="st-main">
    <div class="st-top"><span class="st-search">Search</span><span class="st-live">Live mode</span></div>
    <p class="st-crumb">Customers</p>
    <header class="st-head"><div><h4>Northwind Traders</h4><p>dana@northwind.example · Customer since Mar 2023</p></div><span class="st-btn" data-h="st-credit">Adjust balance</span><span class="st-btn st-btn--more">Actions</span></header>
    <div class="st-balance"><span>Credit balance</span><b>−$50.00</b><em>Applied to the next invoice</em></div>
    <h5>Payments</h5>
    <div class="st-table">
      <div class="st-row st-row--head"><span>Amount</span><span></span><span>Status</span><span>Description</span><span>Date</span><span></span></div>
      ${payment("st-first", "Nov 3, 9:02 AM", "Invoice 2291", " st-row--dup")}
      ${payment("st-second", "Nov 3, 9:02 AM", "Invoice 2291", " st-row--dup st-row--second")}
      ${payment("st-oct", "Oct 3, 9:01 AM", "Invoice 2254")}
      ${payment("st-sep", "Sep 3, 9:00 AM", "Invoice 2217")}
    </div>
    <span class="st-btn st-btn--refund" data-h="st-refund">Refund payment</span>
  </main>
  <div class="st-scrim"><div class="st-modal" data-h="st-modal">
    <h5>Refund payment</h5>
    <p>Refunds take 5 to 10 days to appear on a customer's statement.</p>
    <label>Refund</label><div class="st-input"><span>$480.00</span><em>USD</em></div>
    <label>Reason</label><div class="st-input"><span>Duplicate</span><em>▾</em></div>
    <div class="st-modal__btns"><span class="st-btn">Cancel</span><span class="st-btn st-btn--go" data-h="st-go">Refund</span></div>
  </div></div>
</div>`,
};
