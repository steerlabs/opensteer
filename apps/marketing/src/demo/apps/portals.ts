import "./portals.css";
import adpLogo from "./adp-logo.svg";
import type { BrowserTab } from "./browser.js";
import coupaLogo from "./coupa-logo.png";

const COUPA_FAVICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAA0VXHyAAADiUlEQVQ4EWP8//8/AzJ4/e4Lt6gQz9eZtz/EszIy/P506tKXS7ceaEysip7y/PtfCTV+tnvI6lmQOSC2SVLzOmVpqQcyHs5ftOXF7lVMXTSdgYnpG7OLvdANJlaJpSo8RezMjL/EhXm/gPWCXPD333+mqTffJ7ZcfFnAkzHhMIOE3X/1qMZNIDn92OZVShH1W7/8/sNpVjFvBYNR1Kvi3rWpIDkQBruAiZHh3+sff4SOf/2tsbUkJn+OCJ/HpYdPDT58/sHRlhbSIi8p+OrcxQfSp7Zs92dgZWGR1df8duX9Tw0NAfbbjK+Afl6+/bT9tWfvtGffuB8x28emJCnAfP/r91+5ebjYf3Gys/wGOXXjgatG1+89VbQ217p+hZXTPOvep8JndnLODAs2nrRjUPH9yyDv/p9BzvU/g2Hkp5ppW+NgTkSmv3z7yQZSr5gzeVvqnL31n7/9ZAf7Y/7+614MWVOuBpXPbt9y6Jr+u0/fOZE1wtjt8/eEMJjHv2SQcf4PslAjom4Dw/Sb7xIYtt67ufbBB5////8xfPvxi2XVrgvm564/kYFp/PvvH+PPX3+YQfwDZ+6qSWRP2h3Svqpn08GrBoyM+x9v+v/zj7Qx458bt1esk/105YoCo5Dwmztzal0UZYTeP331iU9MiPtLYe+6HC521q9VKR5LvzIy8ftfeNO9w1AsDxyFn3/+5rDNnzqfQcXnP4Oy9/+GmdujQba1zNkZHl0zvxbErp66JR4YVv8ZbFIeWi08tpRhw523XsefzQSHQdXkTUBJoGZVv/8MPqV3Pn3+zvbsxXtuBvv0uwxueRfBTj99V51BL/wPg5LXf7XEzs23336TvffplywDKMAYrJKfMThlno/r3dAUvPfO1B9//rJZ1y5eAnINg07o3/mbTjn8+POHlbFy0XEGnZAfDOr+/w+dvasKMpiJn5vtx8GJlfbvN/Zb+QQ6nF77ncmd98jTVbd+/REHJ1UGBsbEO29aJ958n54d6r5nw7QmWwEF+aPnbj5RhydlkEkg7HLs2RyGtbf+b3jw0QMcZSAvOWdf6Dx6P51h7c3/lkeeLgSp+/7zN8vP35BYYYLaAqYiRbn2zdETi/GX59shwsf1DiToq6e1K99Mbh6TENdmIWbG7yAxDjaWP2wszH9BbLDNMBcg08/efOJVCqvdev76E2mQ+Nsff/gffv4lhawGxAYAYy8Ap+G1nEMAAAAASUVORK5CYII=";
const ADP_FAVICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAA0VXHyAAAByWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNi4wLjAiPgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczpleGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyI+CiAgICAgICAgIDxleGlmOkNvbG9yU3BhY2U+MTwvZXhpZjpDb2xvclNwYWNlPgogICAgICAgICA8ZXhpZjpQaXhlbFhEaW1lbnNpb24+MzI8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+MzI8L2V4aWY6UGl4ZWxZRGltZW5zaW9uPgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KlrK+YwAAAfdJREFUOBHFks1LG1EUxX9vMtF+5NM0tDGhuCgU+vkHSEIruDBNW2wXzbpdCS7ETbWgC6Hd1SItLm1BBHUtCm4kRFoQdF2LjVBoLWkS0ySTECeT6ZsRrEI3kkUv3JnH454z95wzwpRFC6W0gLWhLROo/9rAbDTAUiaE3cLhsMdMwzi8VxSEbKtOEBjlMpnkEwytiuJ0ggQa+/u4olHaw2Fyc3OogQBGsYi7u5vwxATiuIk/Xr5CS6foHH1BQ5LVv2zLd4V6JkN+fp7w+Diq34/SbJJfWECxzvYe8lHf3SX/4T2X376jtrNDeW3N3qSwtIQzEsF79w7C7cao1chOT+NPJimlUn8J9uTX3bEYlfV1fs3MoMjh0NgYV2ZnKcjVLz0fwdvbC7qOqUrltj3ikKDy6SNl2ReePUXPZvH19eGN36ORy1FcWcEZ6KCtqws1GERxuQgODtoSfPcTiKZhmF8fP+L8jZuU0mmaUrulPzgwgCa3MQ4O6Hj4gL3Xk1wcGuL36iq6lOiNx+mUnoifbybN7yOjnLt9i7PXrhOZmuLb8DDVjQ08PT2YpRLa9mfU9jPommZbdnV5GYdMwypRWFw0rfisjH2JBM5QCG1zk+rWFki3kb+DKxbF4fFQlMA2KcPX32+DbYLjMR7dnuJwFOMpMCdG/z/BH2/yyTUq8hklAAAAAElFTkSuQmCC";

const caret = `<svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
const HOME = `<svg viewBox="0 0 20 18" aria-hidden="true"><path d="M10 1 0.5 9.5H3V17h5.2v-5h3.6v5H17V9.5h2.5Z" fill="currentColor"/></svg>`;
const SEARCH = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10 10 4.2 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
/* The gold coin stack Coupa draws for "create invoice" in a PO's Actions. */
const COINS = `<svg class="cp-coins" viewBox="0 0 22 14" aria-hidden="true"><g fill="#e8b21c" stroke="#b07d0a" stroke-width=".7"><ellipse cx="6" cy="11.5" rx="5" ry="2"/><ellipse cx="6" cy="9" rx="5" ry="2"/><ellipse cx="6" cy="6.5" rx="5" ry="2"/></g><g fill="#e35a3c" stroke="#a83420" stroke-width=".7"><ellipse cx="16" cy="11.5" rx="5" ry="2"/><ellipse cx="16" cy="9" rx="5" ry="2"/></g></svg>`;

const order = (po: string, date: string, items: string, total: string): string =>
  `<tr><td class="cp-num"><span class="cp-lnk">${po}</span></td><td>${date}</td><td>Issued</td><td>None</td><td>${items}</td><td>No</td><td class="cp-num">${total}</td><td>${COINS}</td></tr>`;

/** Coupa Supplier Portal: a customer's purchase orders, signed in. */
export const coupa: BrowserTab = {
  id: "coupa",
  title: "Coupa Supplier Portal",
  url: "supplier.coupahost.com<em>/order_headers</em>",
  mark: `<img class="br-fav" src="${COUPA_FAVICON}" alt="">`,
  page: `<div class="cp">
  <header class="cp-top"><img src="${coupaLogo}" alt="Coupa Supplier Portal" width="232" height="37" loading="lazy"><span class="cp-user">ALEX ${caret}</span><i></i><span>NOTIFICATIONS <b>2</b></span><i></i><span class="cp-help">HELP ${caret}</span></header>
  <nav class="cp-nav"><span class="cp-home">${HOME}</span><span>Invoices</span><span class="is-on">Orders</span><span>Business Profile</span><span>Payments</span><span>Service Sheets</span><span>ASN</span><span>Sourcing</span><span>Forecasts</span><span>Catalogs</span><span>Setup</span><span>More...</span></nav>
  <div class="cp-sub"><span class="is-on">Orders</span><span>Order Lines</span></div>
  <div class="cp-head"><div class="cp-co">Halcyon Labs</div><label>Select Customer <span class="cp-select">Halcyon Labs ${caret}</span></label></div>
  <div class="cp-h1">Purchase Orders</div>
  <div class="cp-tip">Click the ${COINS} Action to Invoice from a Purchase Order</div>
  <table class="cp-table">
    <tr class="cp-bar"><td colspan="8"><span>View <span class="cp-select">Open Orders ${caret}</span></span><span class="cp-search">Search${SEARCH}</span></td></tr>
    <tr><th>PO Number</th><th>Order Date</th><th>Status</th><th>Acknowledged At</th><th>Items</th><th>Unanswered Comments</th><th>Total</th><th>Actions</th></tr>
    ${order("4500018871", "10/01/26", "Brand system — October", "9,300.00 USD")}
    ${order("4500018865", "09/01/26", "Brand system — September", "8,625.00 USD")}
  </table>
</div>`,
};

const card = (title: string, body: string): string =>
  `<div class="adp-card"><h3>${title}</h3>${body}</div>`;
const action = (label: string): string => `<span class="adp-act"><i></i>${label}</span>`;

/** ADP Workforce Now, the employee home page, signed in. */
export const adp: BrowserTab = {
  id: "adp",
  title: "ADP Workforce Now",
  url: "workforcenow.adp.com<em>/theme/index.html#/Myself_ttd_MyselfTabTilesCategoryHome</em>",
  mark: `<img class="br-fav" src="${ADP_FAVICON}" alt="">`,
  page: `<div class="adp">
  <header class="adp-top"><img src="${adpLogo}" alt="ADP" width="44" height="20" loading="lazy"><i></i><b>Lumen Studio</b><span class="adp-search">${SEARCH}</span><span class="adp-ico"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#fff"/><path d="m4.8 8.2 2.2 2.2 4.2-4.4" fill="none" stroke="#121c4e" stroke-width="1.6"/></svg>Things to Do</span><span class="adp-ico"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="#fff"/><path d="M5 1.5v3M11 1.5v3" stroke="#fff" stroke-width="1.6"/><path d="M4 7h2v1.6H4zM7 7h2v1.6H7zM10 7h2v1.6h-2zM4 10h2v1.6H4zM7 10h2v1.6H7z" fill="#121c4e"/></svg>Calendar</span><span class="adp-me">AR</span></header>
  <nav class="adp-nav"><span class="is-on">Home</span><span>Resources ${caret}</span><span>Myself ${caret}</span></nav>
  <div class="adp-cards">
    ${card("Things to Do", `<p><b>Congratulations</b><br>You've completed all of your<br>Things to Do tasks</p>`)}
    ${card("What Would You Like to Do?", `<div class="adp-acts">${action("Update Tax Withholdings")}${action("Update Payment Options")}${action("Update Profile")}</div>`)}
    ${card("My pay", `<div class="adp-pay"><small>Compensation</small><span class="adp-show">Show</span><i class="adp-donut"></i><dl><dt>--</dt><dt>TAKE HOME</dt><dd>$X.XX</dd><dt>GROSS PAY</dt><dd>$X.XX</dd></dl></div>`)}
    ${card("Helpful Links", `<div class="adp-links"><span>Salary Paycheck Calculator</span><span>Hourly Paycheck Calculator</span><span>Tax Withholding Estimator</span></div>`)}
  </div>
</div>`,
};
