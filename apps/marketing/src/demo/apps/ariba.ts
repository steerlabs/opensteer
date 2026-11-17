import "./ariba.css";
import type { BrowserTab } from "./browser.js";
import { SAP_LOGO } from "./sap-logo.js";

const DOWN = `<svg class="ar-dd" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
const CAL = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M1.5 6h13M5 1v3M11 1v3" stroke="currentColor" stroke-width="1.1"/><path d="M4 8.5h2v1.6H4zM7 8.5h2v1.6H7zM10 8.5h2v1.6h-2zM4 11.3h2v1.6H4zM7 11.3h2v1.6H7z" fill="currentColor"/></svg>`;

/** The portal's shell bar, as a supplier on a Standard account sees it. */
const SHELL = `<div class="ar-shell"><span class="ar-logo">${SAP_LOGO(48)}</span><b>Business Network</b><i class="ar-caret"></i><span>Standard Account</span><span class="ar-upgrade">Upgrade</span><span class="ar-shell-r"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.6" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M7.5 7.7c0-1.5 1.1-2.5 2.6-2.5s2.5 1 2.5 2.3c0 1.1-.6 1.6-1.4 2.1-.7.5-1.1.9-1.1 1.8v.5" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="10.1" cy="14.4" r="1" fill="#fff"/></svg><span class="ar-avatar">AR</span></span></div>`;

const kv = (label: string, value: string, bold = false): string =>
  `<div class="ar-r"><span class="ar-k${bold ? " is-b" : ""}">${label}</span><span class="ar-v${bold ? " is-b" : ""}">${value}</span></div>`;

const LUMEN = `<div>Postal Address:</div><div>2140 Folsom Street</div><div>San Francisco, CA 94110</div><div>United States</div>`;
const BRIGHTLINE = `<div>Postal Address:</div><div>PO Box 8810</div><div>Portland, OR 97208</div><div>United States</div>`;
const address = (title: string, name: string, lines: string): string =>
  `<div class="ar-addr"><h6>${title}</h6><div class="ar-nm">${name}</div>${lines}</div>`;

const btn = (label: string, hook = "", em = false): string =>
  `<span class="ar-btn${em ? " is-em" : ""}"${hook ? ` data-h="${hook}"` : ""}>${label}</span>`;

/** Create Invoice, the entry step: the header fields the supplier keys in from the PO. */
const ENTRY = `<div class="ar-view ar-entry">
  <div class="ar-phead"><span class="ar-ptitle">Create Invoice</span></div>
  <div class="ar-panel">
    <div class="ar-sect"><i class="ar-tri"></i>Invoice Header</div>
    <div class="ar-sub">Summary</div>
    <div class="ar-form">
      <div class="ar-fields">
        ${kv("Purchase Order:", "4500018872")}
        <div class="ar-r ar-r--in"><span class="ar-k">Invoice #:<em>*</em></span><span class="ar-in" data-h="ar-no-field"><span data-h="ar-no"></span></span></div>
        <div class="ar-r ar-r--in"><span class="ar-k">Invoice Date:<em>*</em></span><span class="ar-in ar-in--date">17 Nov 2026${CAL}</span></div>
        <div class="ar-r ar-r--in"><span class="ar-k">Service Description:</span><span class="ar-in ar-in--wide" data-h="ar-desc-field"><span data-h="ar-desc"></span></span></div>
        <div class="ar-r ar-r--top"><span class="ar-k">Remit To:</span><span class="ar-v">Lumen Studio LLC<br>2140 Folsom Street<br>San Francisco, CA 94110<br>United States</span></div>
        <div class="ar-r ar-r--top"><span class="ar-k">Bill To:</span><span class="ar-v">Brightline Health – Accounts Payable<br>PO Box 8810<br>Portland, OR 97208</span></div>
      </div>
      <div class="ar-sums">
        ${kv("Subtotal:", "$12,675.00 USD", true)}
        ${kv("Total Tax:", "$0.00 USD")}
        ${kv("Amount Due:", "$12,675.00 USD", true)}
      </div>
    </div>
  </div>
  <div class="ar-foot-bar">${btn("Update")}${btn("Save")}${btn("Exit")}${btn("Next", "ar-next", true)}</div>
</div>`;

/** Create Invoice, the review step, then the portal's page once it is submitted. */
const REVIEW = `<div class="ar-view ar-review">
  <div class="ar-phead"><span class="ar-ptitle">Create Invoice</span><span class="ar-pbtns">${btn("Previous")}${btn("Save", "ar-save")}${btn("Submit", "ar-submit", true)}${btn("Exit")}</span></div>
  <div class="ar-panel">
    <p class="ar-confirm">Confirm and submit this document. It will be electronically signed according to the countries of origin and destination of invoice. The document's originating country is:United States. The document's destination country is:United States.</p>
    <div class="ar-doc">Standard Invoice</div>
    <div class="ar-sum">
      <div class="ar-kv">
        ${kv("Invoice Number:", "LUMEN-0143")}
        ${kv("Invoice Date:", "Tuesday 17 Nov 2026 9:44 AM GMT-08:00")}
        ${kv("Original Purchase Order:", "4500018872")}
        ${kv("Service Description:", "Patient portal redesign, October 2026")}
        ${kv("Customer:", "Brightline Health")}
      </div>
      <div class="ar-kv ar-kv--totals">
        ${kv("Subtotal:", "$12,675.00 USD", true)}
        ${kv("Total Tax:", "$0.00 USD")}
        ${kv("Total Gross Amount:", "$12,675.00 USD")}
        ${kv("Total Net Amount:", "$12,675.00 USD")}
        ${kv("Amount Due:", "$12,675.00 USD", true)}
      </div>
    </div>
    <div class="ar-addrs">
      ${address("REMIT TO:", "Lumen Studio LLC", LUMEN)}
      ${address("BILL TO:", "Brightline Health – Accounts Payable", BRIGHTLINE)}
      ${address("SUPPLIER:", "Lumen Studio LLC", LUMEN)}
      ${address("BILL FROM:", "Lumen Studio LLC", LUMEN)}
      ${address("CUSTOMER:", "Brightline Health", BRIGHTLINE)}
    </div>
  </div>
  <div class="ar-done">
    <div class="ar-done-box"><b data-h="ar-done-title">Invoice LUMEN-0143 has been submitted.</b><ul><li><span class="ar-lnk">Print</span> a copy of the invoice.</li><li><span class="ar-lnk">Exit</span> invoice creation.</li></ul></div>
    <div class="ar-copy">${SAP_LOGO(51)}<span>© 2026 SAP SE or an SAP affiliate company. All rights reserved.</span></div>
  </div>
</div>`;

const MARK = `<i class="br-fav ar-fav">${SAP_LOGO(16)}</i>`;

/** SAP Business Network: the customer's invoice in Brightline Health's supplier portal. */
export const ariba: BrowserTab = {
  id: "ariba",
  title: "SAP Business Network",
  url: "service.ariba.com<em>/Supplier.aw/109555061/aw?awh=r&amp;awssk=Xp2Q8kLm&amp;dard=1</em>",
  mark: MARK,
  page: `<div class="ar">${SHELL}${ENTRY}${REVIEW}</div>`,
};

const tab = (label: string, state = "", menu = false): string =>
  `<span class="ar-tab${state}">${label}${menu ? DOWN : ""}</span>`;
const tile = (count: number, label: string, period: string, on = false): string =>
  `<div class="ar-tile${on ? " is-on" : ""}"><b>${count}</b><span>${label}</span><small>${period}</small></div>`;

/** The supplier's Workbench, signed in. */
export const aribaWorkbench: BrowserTab = {
  id: "ariba-home",
  title: "SAP Business Network",
  url: "service.ariba.com<em>/Supplier.aw/109555061/aw?awh=r&amp;awssk=Xp2Q8kLm&amp;dard=1</em>",
  mark: MARK,
  page: `<div class="ar">${SHELL}<div class="ar-view ar-wb">
    <div class="ar-tabs">${tab("Home")}${tab("Enablement")}${tab("Workbench", " is-on")}${tab("Orders", " is-dim", true)}${tab("Fulfillment", " is-dim", true)}${tab("Invoices", " is-dim", true)}${tab("Payments", " is-dim", true)}${tab("Catalogs")}${tab("Reports", " is-dim", true)}</div>
    <div class="ar-card">
      <div class="ar-card-h">Workbench</div>
      <div class="ar-tiles">${tile(13, "Orders", "Last 90 days")}${tile(5, "Orders to invoice", "Last 90 days")}${tile(8, "Invoices", "Last 90 days", true)}${tile(0, "Draft invoices", "Last 31 days")}${tile(0, "Rejected invoices", "Last 31 days")}${tile(0, "Pinned documents", "Last 31 days")}</div>
      <div class="ar-ih"><b>Invoices <span>(8)</span></b><div><span class="ar-lnk">› Edit filter</span><i></i><span class="ar-lnk">Save filter</span><i></i><span class="ar-chip">Last 90 days</span></div></div>
    </div>
  </div></div>`,
};
