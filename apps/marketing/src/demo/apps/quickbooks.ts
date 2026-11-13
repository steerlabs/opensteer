import "./quickbooks.css";

const svg = (w: number, h: number, body: string): string =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const G = "#5B5B5F";
const GD = "#B4B4B8";
/* Time/Costs, Progress, History and Payments are traced from the invoice window glyphs in Intuit's QuickBooks Mac Plus User's Guide (2024). */
const traced = (box: string, color: string, body: string): string =>
  `<svg width="19" height="16" viewBox="${box}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter">${body}</svg>`;
const I = {
  prev: svg(
    18,
    18,
    `<path d="M9 2.5v9.2M5.2 8.2 9 12l3.8-3.8" stroke="${G}" stroke-width="1.5"/><path d="M4 15.2h10" stroke="${G}" stroke-width="1.5"/>`,
  ),
  next: svg(
    18,
    18,
    `<path d="M9 15.5V6.3M5.2 9.8 9 6l3.8 3.8" stroke="${G}" stroke-width="1.5"/><path d="M4 2.8h10" stroke="${G}" stroke-width="1.5"/>`,
  ),
  print: svg(
    18,
    18,
    `<path d="M5 6.5V2.5h8v4" stroke="${G}" stroke-width="1.3"/><rect x="1.8" y="6.5" width="14.4" height="6.6" rx="1.4" stroke="${G}" stroke-width="1.3"/><path d="M5 10.5h8v5H5z" fill="#fff" stroke="${G}" stroke-width="1.3"/><circle cx="13.6" cy="8.8" r=".8" fill="${G}"/>`,
  ),
  email: svg(
    18,
    18,
    `<rect x="1.8" y="4" width="14.4" height="10" rx="1.4" stroke="${G}" stroke-width="1.3"/><path d="M2.4 4.8 9 10l6.6-5.2" stroke="${G}" stroke-width="1.3"/>`,
  ),
  eye: svg(
    18,
    18,
    `<path d="M1.5 9C3.3 5.8 6 4.3 9 4.3s5.7 1.5 7.5 4.7C14.7 12.2 12 13.7 9 13.7S3.3 12.2 1.5 9z" stroke="${G}" stroke-width="1.3"/><circle cx="9" cy="9" r="2.5" fill="${G}"/>`,
  ),
  time: traced(
    "14 5 38 32",
    GD,
    `<circle cx="25.8" cy="16.3" r="9.6"/><path d="M25.6 11v5.6H31"/><path d="M38.6 16.6h11.9V35H26.6v-7"/><path d="M42.9 23C42.2 21.8 41.2 21.3 40 21.3c-1.9 0-3.1 1.1-3.1 2.5 0 1.7 1.5 2.3 3.2 2.8 1.8.6 3.1 1.2 3.1 2.8 0 1.5-1.3 2.3-3.2 2.3-1.4 0-2.6-.6-3.4-1.8M40 19.3v2M40 31.7v1.6"/>`,
  ),
  progress: traced(
    "18.5 6.5 38 32",
    GD,
    `<path d="M37.6 15v7.6H45"/><path d="M37.4 9.7A12.9 12.9 0 0 1 43.9 33.6"/><path d="M43.6 28.4v6.1h6.2"/><g fill="${GD}" stroke="none"><circle cx="32.8" cy="10" r="1.15"/><circle cx="28.4" cy="12.7" r="1.15"/><circle cx="25.9" cy="17" r="1.15"/><circle cx="24.5" cy="22.5" r="1.15"/><circle cx="25.9" cy="28.3" r="1.15"/><circle cx="28.8" cy="32.6" r="1.15"/><circle cx="34" cy="35" r="1.15"/></g>`,
  ),
  history: traced(
    "18 5.5 38 32",
    G,
    `<path d="M36.6 14v7.6h6"/><path d="M21.7 22.6A14.2 14.2 0 1 0 27.6 9.8L21.4 15.6"/><path d="M21.4 9.4v6.4h7"/>`,
  ),
  payments: traced(
    "13 4 40 33.7",
    G,
    `<path d="M20.6 5.3v10.6M15.3 11.6l5.3 5 5.3-5"/><path d="M29.6 10.9h18v19.3H14.9V17"/><path d="M18.2 33.6h33.4V14"/><path d="M34.7 18.2c-.6-1.2-1.7-1.8-3.2-1.8-1.7 0-2.9.9-2.9 2.1 0 1.4 1.3 1.9 2.9 2.3 1.7.5 3.1 1.1 3.1 2.6 0 1.4-1.3 2.3-3.2 2.3-1.4 0-2.5-.6-3.2-1.6M31.3 14.2v2.1M31.6 25v1.8"/>`,
  ),
  group: svg(
    22,
    18,
    `<circle cx="11" cy="6" r="2.6" stroke="${G}" stroke-width="1.3"/><path d="M6.4 15.2c0-2.8 2-4.4 4.6-4.4s4.6 1.6 4.6 4.4" stroke="${G}" stroke-width="1.3"/><circle cx="4.9" cy="7.4" r="1.9" stroke="${G}" stroke-width="1.2"/><path d="M1.4 14.6c0-2 1.3-3.3 3.3-3.4" stroke="${G}" stroke-width="1.2"/><circle cx="17.1" cy="7.4" r="1.9" stroke="${G}" stroke-width="1.2"/><path d="M20.6 14.6c0-2-1.3-3.3-3.3-3.4" stroke="${G}" stroke-width="1.2"/>`,
  ),
  paneL: svg(
    20,
    16,
    `<rect x="1.5" y="2" width="17" height="12" rx="1.6" stroke="${G}" stroke-width="1.3"/><path d="M2.2 2.7h4.8v10.6H2.2z" fill="${G}"/><path d="M7 2v12" stroke="${G}" stroke-width="1.3"/>`,
  ),
  paneR: svg(
    20,
    16,
    `<rect x="1.5" y="2" width="17" height="12" rx="1.6" stroke="${G}" stroke-width="1.3"/><path d="M13 2v12" stroke="${G}" stroke-width="1.3"/><path d="M14.6 5h2.4M14.6 7.4h2.4M14.6 9.8h2.4" stroke="${G}" stroke-width="1.1"/>`,
  ),
  clip: svg(
    18,
    18,
    `<path d="M12.4 6.2 7 11.6a1.7 1.7 0 0 1-2.4-2.4l6-6a3 3 0 0 1 4.3 4.3l-6.4 6.4a4.3 4.3 0 0 1-6.1-6.1L7.6 2.6" stroke="${G}" stroke-width="1.3"/>`,
  ),
  chev: (color: string): string =>
    svg(9, 6, `<path d="M1 1.2l3.5 3.4L8 1.2" stroke="${color}" stroke-width="1.4"/>`),
  tri: svg(7, 5, `<path d="M.5.5h6L3.5 4.5z" fill="#5E5E62"/>`),
  search: svg(
    13,
    13,
    `<circle cx="5.4" cy="5.4" r="4.1" stroke="#8D8D92" stroke-width="1.3"/><path d="M8.5 8.5l3.4 3.4" stroke="#8D8D92" stroke-width="1.4"/>`,
  ),
  plusGreen: svg(
    16,
    16,
    `<path d="M6 1.5h4v4.5h4.5v4H10v4.5H6V10H1.5V6H6z" fill="#3BAA35" stroke="#2C8A27" stroke-width=".8" stroke-linejoin="round"/>`,
  ),
  plus: svg(11, 11, `<path d="M5.5 1v9M1 5.5h9" stroke="#545458" stroke-width="1.3"/>`),
  minus: svg(11, 11, `<path d="M1 5.5h9" stroke="#545458" stroke-width="1.3"/>`),
  dup: svg(
    13,
    12,
    `<rect x="1" y="1" width="7.5" height="7" rx="1" stroke="#545458" stroke-width="1.1"/><path d="M4.5 10.8h6.5a1 1 0 0 0 1-1V4.3" stroke="#545458" stroke-width="1.1"/>`,
  ),
  grip: svg(10, 10, `<path d="M2 1v8M5 1v8M8 1v8" stroke="#9A9A9E" stroke-width="1"/>`),
};

const tool = (x: number, label: string, inner: string, off = false): string =>
  `<div class="qb-tool${off ? " is-off" : ""}" style="left:${x}px">${inner}<span>${label}</span></div>`;
const seg = (...buttons: string[]): string =>
  `<div class="qb-seg">${buttons.map((b) => `<i>${b}</i>`).join("")}</div>`;

const TOOLBAR = `<div class="qb-tool" style="left:16px"><div class="qb-seg"><i>${I.prev}</i><i>${I.next}</i></div><span class="qb-pair"><span>Prev</span><span>Next</span></span></div>
${tool(112, "Share", seg(I.print, I.email, I.eye))}
${tool(248, "Current Template", `<div class="qb-seg"><span class="qb-pop">Standard Service Invoice${I.chev("#6B6B70")}</span></div>`)}
${tool(456, "Time/Costs", seg(I.time), true)}
${tool(528, "Progress", seg(I.progress), true)}
${tool(596, "History", seg(I.history))}
${tool(664, "Payments", seg(I.payments))}
${tool(737, "New Group", seg(I.group))}
${tool(1036, "View", `<div class="qb-seg"><i class="is-on">${I.paneL}</i><i>${I.paneR}</i></div>`)}
${tool(1118, "Attach", seg(I.clip))}`;

const listRow = (name: string, amount: string, date: string, number: string, extra = ""): string =>
  `<div class="qb-row${extra}"><div><b>${name}</b><b>$${amount}</b></div><div><span>${date}</span><span>#${number}</span></div></div>`;

const OLD = [
  ["Tidewater Co.", "6,525.00", "10/15/2026", "LUMEN-0141"],
  ["Parallel Capital", "7,800.00", "10/15/2026", "LUMEN-0140"],
  ["Oak &amp; Ember", "3,450.00", "10/15/2026", "LUMEN-0139"],
  ["Kestrel Robotics", "5,400.00", "10/15/2026", "LUMEN-0138"],
  ["Brightline Health", "11,250.00", "10/15/2026", "LUMEN-0137"],
  ["Halcyon Labs", "8,625.00", "10/15/2026", "LUMEN-0136"],
  ["Tidewater Co.", "5,800.00", "9/16/2026", "LUMEN-0135"],
  ["Parallel Capital", "7,200.00", "9/16/2026", "LUMEN-0134"],
];

/** A field's three states: Halcyon's saved invoice, then Brightline's header, then its line. */
const v = (old: string, next: string, when: "qn" | "qh" | "ql" = "qh"): string =>
  `<span class="qo">${old}</span><span class="${when}">${next}</span>`;

const BLANK = Array.from(
  { length: 7 },
  (_, k) =>
    `<div class="qb-tr${k % 2 === 0 ? " alt" : ""}"><span class="c-item"></span><span class="c-desc"></span><span class="c-qty"></span><span class="c-rate"></span><span class="c-amt"></span></div>`,
).join("");

/** QuickBooks Desktop for Mac (Mac Plus 2024), its Invoices window in the light appearance. */
export const quickbooks = `<div class="win qb is-open" data-win="quickbooks" style="left:92px;top:60px;width:1170px;height:690px">
  <div class="qb-head">
    <span class="tl"><i></i><i></i><i></i></span><b>Invoices — Lumen Studio LLC</b>
    ${TOOLBAR}
  </div>
  <div class="qb-body">
    <div class="qb-list">
      <div class="qb-list-hd"><span class="qb-search">${I.search}Filter Invoices</span><span class="qb-sort">Sort by Date ${I.tri}</span></div>
      <div class="qb-create" data-h="qb-create">${I.plusGreen}<span>Create Invoice…</span></div>
      <div class="qb-rows">
        ${listRow("Brightline Health", "12,675.00", "11/17/2026", "LUMEN-0143", " qb-row--new")}
        ${listRow("Halcyon Labs", "9,300.00", "11/17/2026", "LUMEN-0142", " qb-row--old")}
        ${OLD.map(([name = "", amount = "", date = "", number = ""]) => listRow(name, amount, date, number)).join("")}
      </div>
      <div class="qb-lbar"><i>${I.plus}</i><i>${I.minus}</i><i>${I.dup}</i><span></span><b>${I.grip}</b></div>
    </div>
    <div class="qb-main">
      <div class="qb-band">
        <div class="qb-combo" data-h="qb-customer"><span class="qo">Halcyon Labs</span><span class="qb-typed" data-h="qb-typed"></span><span class="qb-arrows">${I.chev("#fff")}</span></div>
      </div>
      <div class="qb-canvas">
        <div class="qb-paper">
          <div class="qb-h1">Invoice</div>
          <div class="qb-box" style="left:666px;top:16px;width:92px"><div class="qb-box-h">Date</div><div class="qb-box-v">${v("11/17/2026", "11/17/2026", "qn")}</div></div>
          <div class="qb-box" style="left:756px;top:16px;width:102px"><div class="qb-box-h">Invoice No.</div><div class="qb-box-v">${v("LUMEN-0142", "LUMEN-0143", "qn")}</div></div>
          <div class="qb-box" style="left:22px;top:62px;width:268px;height:80px"><div class="qb-box-h is-left">Bill To</div>
            <div class="qb-addr"><div>${v("Halcyon Labs", "Brightline Health")}</div><div>${v("Attn: Priya Raman", "Attn: Marcus Oyelaran")}</div><div>${v("Accounts Payable", "Accounts Payable")}</div></div></div>
          <div class="qb-box" style="left:490px;top:158px;width:128px"><div class="qb-box-h">P.O. Number</div><div class="qb-box-v is-left">${v("4500018871", "4500018872")}</div></div>
          <div class="qb-box" style="left:616px;top:158px;width:128px"><div class="qb-box-h">Terms</div><div class="qb-box-v is-left">${v("Net 14", "Net 14")}<span class="qb-dd">${I.tri}</span></div></div>
          <div class="qb-box" style="left:742px;top:158px;width:116px"><div class="qb-box-h">Due Date</div><div class="qb-box-v">${v("12/01/2026", "12/01/2026")}</div></div>
          <div class="qb-tbl">
            <div class="qb-tr hd"><span class="c-item">Item</span><span class="c-desc">Description</span><span class="c-qty">Quantity</span><span class="c-rate">Rate</span><span class="c-amt">Amount</span></div>
            <div class="qb-tr" data-h="qb-line"><span class="c-item">${v("Consulting", "Consulting", "ql")}</span><span class="c-desc">${v("Brand system — October", "Patient portal redesign — October", "ql")}</span><span class="c-qty">${v("62", "84.5", "ql")}</span><span class="c-rate">${v("150.00", "150.00", "ql")}</span><span class="c-amt">${v("9,300.00", "12,675.00", "ql")}</span></div>
            ${BLANK}
          </div>
          <div class="qb-msg">${v("Thank you for your business.", "Thank you for your business.", "ql")}<span class="qb-dd">${I.tri}</span></div>
          <div class="qb-total-l">Total</div>
          <div class="qb-total-v">${v("9,300.00", "12,675.00", "ql")}<span class="qz">0.00</span></div>
        </div>
      </div>
      <div class="qb-bbar">
        <div class="qb-bal">Balance Due:<b>${v("9,300.00", "12,675.00", "ql")}<span class="qz">0.00</span></b></div>
        <div class="qb-memo">${v("October 2026 services · Brand system", "October 2026 services · Patient portal redesign", "ql")}<span class="qb-ph">Memo</span></div>
        <div class="qb-help">?</div>
        <div class="qb-btn" style="left:729px">Cancel</div>
        <div class="qb-btn qb-btn--save" style="left:825px" data-h="qb-save">Save</div>
      </div>
    </div>
  </div>
</div>`;
