import "./stripe.css";
import type { BrowserTab } from "./browser.js";

const path = (d: string): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${d}"/></svg>`;

const I = {
  home: path("M3.5 9 10 3.5 16.5 9v7.5h-4.5v-4.5h-4v4.5H3.5Z"),
  balances: path("M3 7.5 10 3.5l7 4M4.5 8.5v6M8 8.5v6M12 8.5v6M15.5 8.5v6M3 16.5h14"),
  transactions: path("M4 7h11.5M12.5 4l3 3-3 3M16 13H4.5M7.5 10l-3 3 3 3"),
  customers: path("M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 17c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5"),
  catalog: path("M3.5 6.5 10 3.5l6.5 3v7L10 16.5l-6.5-3ZM3.5 6.5 10 9.5l6.5-3M10 9.5v7"),
  billing: path("M5.5 3h9v14l-2-1.3-1.5 1.3L9.5 15.7 8 17l-2.5-1.5ZM8 7h4M8 10h4"),
  reporting: path("M3.5 16.5h13M6 13.5V9M10 13.5V5.5M14 13.5v-6"),
  more: path("M5 10h.1M10 10h.1M15 10h.1"),
  search: path("M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12.5 12.5 16.5 16.5"),
  help: path(
    "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM7.9 7.9a2.2 2.2 0 1 1 3 2c-.6.3-.9.7-.9 1.4M10 13.9v.1",
  ),
  bell: path(
    "M10 3a4.5 4.5 0 0 0-4.5 4.5V11L4 13.5h12L14.5 11V7.5A4.5 4.5 0 0 0 10 3ZM8.3 16a1.8 1.8 0 0 0 3.4 0",
  ),
  gear: path(
    "M10 12.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM8.6 2.8h2.8l.4 2 1.5.9 1.9-.7 1.4 2.4-1.5 1.3v1.8l1.5 1.3-1.4 2.4-1.9-.7-1.5.9-.4 2H8.6l-.4-2-1.5-.9-1.9.7-1.4-2.4 1.5-1.3V9.1L3.4 7.8l1.4-2.4 1.9.7 1.5-.9Z",
  ),
  plus: path("M10 5v10M5 10h10"),
  caret: path("M6 8l4 4 4-4"),
  check: path("M5 10.5 8.5 14 15 6.5"),
  refunded: path("M7.5 5 4 8.5 7.5 12M4 8.5h7.5a4.5 4.5 0 0 1 0 9H9"),
  receipt: path("M3 5h14v10H3ZM3.5 5.5 10 11l6.5-5.5"),
  copy: path("M7 7h9.5v9.5H7ZM13 7V3.5H3.5V13H7"),
  open: path("M11.5 3.5h5v5M16.5 3.5 9.5 10.5M8 4.5H3.5v12h12V12"),
  close: path("M6 6l8 8M14 6l-8 8"),
} as const;

const dots = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15.5" cy="10" r="1.5"/></svg>`;

const VISA = `<i class="st-visa">VISA</i>`;

const nav = (icon: string, label: string, on = false): string =>
  `<span${on ? ' class="is-on"' : ""}>${icon}${label}</span>`;

const MENU = `<div class="st-menu">
  <span data-h="st-refund">${I.refunded}Refund payment</span>
  <span>${I.receipt}Send receipt</span>
  <span>${I.copy}Copy payment ID</span>
  <i></i>
  <span>${I.open}View payment details</span>
</div>`;

const payment = (hook: string, date: string, invoice: string, extra = "", more = ""): string =>
  `<div class="st-row${extra}" data-h="${hook}"><b>$480.00</b><span class="st-status"><i class="st-badge st-badge--ok">Succeeded${I.check}</i><i class="st-badge st-badge--back">Refunded${I.refunded}</i></span><span>${invoice}</span><span>${date}</span><span class="st-more"${more ? ` data-h="${more}"` : ""}>${dots}</span>${more ? MENU : ""}</div>`;

const detail = (label: string, value: string, extra = "", action = ""): string =>
  `<div class="st-detail${extra}"><span>${label}${action}</span><b>${value}</b></div>`;

export const stripe: BrowserTab = {
  id: "stripe",
  title: "Northwind Traders – Stripe",
  url: "dashboard.stripe.com<em>/customers/cus_Qn4Northwind</em>",
  mark: `<i class="br-fav" style="background:#635bff">S</i>`,
  page: `<div class="st">
  <aside class="st-side">
    <div class="st-account" data-h="st-account"><i>R</i><span>Rivera &amp; Co.</span>${I.caret}</div>
    <nav>${nav(I.home, "Home")}${nav(I.balances, "Balances")}${nav(I.transactions, "Transactions")}${nav(I.customers, "Customers", true)}${nav(I.catalog, "Product catalog")}</nav>
    <h6>Products</h6>
    <nav>${nav(I.billing, "Billing")}${nav(I.reporting, "Reporting")}${nav(I.more, "More")}</nav>
  </aside>
  <main class="st-main">
    <div class="st-top"><span class="st-search">${I.search}Search</span><span class="st-top__end">${I.help}${I.bell}${I.gear}<i class="st-create">${I.plus}</i></span></div>
    <div class="st-page">
      <p class="st-crumb">Customers</p>
      <header class="st-head"><i class="st-tile">${I.customers}</i><div><h4>Northwind Traders</h4><p>dana@northwind.example</p></div><span class="st-btn">Actions${I.caret}</span></header>
      <div class="st-cols">
        <section class="st-pay">
          <h5>Payments<span class="st-btn st-btn--sm">${I.plus}Create</span></h5>
          <div class="st-table">
            <div class="st-row st-row--head"><span>Amount</span><span>Status</span><span>Description</span><span>Date</span><span></span></div>
            ${payment("st-first", "Nov 3, 9:02 AM", "Invoice 2291", " st-row--dup")}
            ${payment("st-second", "Nov 3, 9:02 AM", "Invoice 2291", " st-row--dup st-row--second", "st-more")}
            ${payment("st-oct", "Oct 3, 9:01 AM", "Invoice 2254")}
            ${payment("st-sep", "Sep 3, 9:00 AM", "Invoice 2217")}
            ${payment("st-aug", "Aug 3, 9:02 AM", "Invoice 2180")}
          </div>
          <p class="st-count">5 results</p>
        </section>
        <aside class="st-details">
          <h6>Details</h6>
          ${detail("Customer since", "Mar 12, 2023")}
          ${detail("Spend", `<span class="st-was">$22,080.00</span><span class="st-now">$21,600.00</span>`)}
          ${detail("MRR", "$480.00")}
          ${detail("Payment method", `${VISA}•••• 4242`)}
          ${detail(
            "Balance",
            `<span class="st-was">$0.00</span><span class="st-now">$50.00</span>`,
            " st-detail--credit",
            `<a data-h="st-credit">Adjust</a>`,
          )}
        </aside>
      </div>
    </div>
  </main>
  <div class="st-scrim"><div class="st-modal" data-h="st-modal">
    <header><h5>Refund payment</h5>${I.close}</header>
    <p>Refunds take 5–10 days to appear on a customer's statement. Stripe's fees for the original payment won't be returned.</p>
    <label>Refund</label><div class="st-input"><span>$480.00</span><em>USD</em></div>
    <label>Reason</label><div class="st-input"><span>Duplicate</span>${I.caret}</div>
    <label>Details <em>Optional</em></label><div class="st-input st-input--area"><span>Charged twice for invoice 2291.</span></div>
    <div class="st-modal__btns"><span class="st-btn">Cancel</span><span class="st-btn st-btn--go" data-h="st-go">Refund</span></div>
  </div></div>
</div>`,
};
