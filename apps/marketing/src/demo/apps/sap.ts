import "./sap.css";
import { SAP_LOGO } from "./sap-logo.js";

const svg = (w: number, h: number, body: string): string =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/* System toolbar icons, 22pt, drawn to SAP GUI for Java's Blue Crystal set. */
const GR = "#6B6B6B";
const AG = "#2EA866";
const T = (body: string): string => svg(22, 22, body);
const circ = (fill: string, inner: string): string =>
  T(`<circle cx="11" cy="11" r="10" fill="${fill}"/>${inner}`);
const page = (arrows: string): string =>
  T(
    `<path d="M7.5 3.5h7l3 3v12h-10z" fill="#fff" stroke="${GR}" stroke-width="1.2" stroke-linejoin="miter"/><path d="M14.5 3.5v3h3" stroke="${GR}" stroke-width="1.1" stroke-linejoin="miter"/>${arrows}`,
  );
const STD = [
  [11, circ("#008D2E", `<path d="M6.3 11.4l3.3 3.2 6.2-7" stroke="#fff" stroke-width="2.5"/>`)],
  [
    209,
    T(
      `<path d="M2 2h14.6L20 5.4V20H2z" fill="#CCCCCC"/><path d="M5.8 2h9.4v6.2H5.8z" fill="#F2F3F3"/><path d="M12 3.3h2v3.6h-2z" fill="#CCCCCC"/><path d="M4.6 11.8h12.8V20H4.6z" fill="#F2F3F3"/><path d="M6.6 14.3h8.8M6.6 17h8.8" stroke="#D9D9D9" stroke-width="1"/>`,
    ),
  ],
  [
    244,
    circ(
      "#2EA866",
      `<path d="M11.4 7l-4 4 4 4M15.6 7l-4 4 4 4" stroke="#fff" stroke-width="2.1"/>`,
    ),
  ],
  [
    272,
    circ("#F7A600", `<path d="M7 11.6l4-4 4 4M7 15.8l4-4 4 4" stroke="#fff" stroke-width="2.1"/>`),
  ],
  [
    300,
    circ(
      "#EB3F45",
      `<path d="M7.4 7.4l7.2 7.2M14.6 7.4l-7.2 7.2" stroke="#fff" stroke-width="2.5"/>`,
    ),
  ],
  [
    334,
    T(
      `<path d="M6 3h10v5H6z" fill="#fff" stroke="${GR}" stroke-width="1.3" stroke-linejoin="miter"/><rect x="2" y="7.5" width="18" height="8.5" rx="1.4" fill="${GR}"/><path d="M6 13h10v6.5H6z" fill="#fff" stroke="${GR}" stroke-width="1.3" stroke-linejoin="miter"/><path d="M8 15.4h6M8 17.6h6" stroke="#1E9BE0" stroke-width="1.2" stroke-linecap="butt"/><circle cx="17" cy="10.3" r=".9" fill="#fff"/>`,
    ),
  ],
  [
    362,
    T(
      `<path d="M3.2 9.5l1.6-5.2c.3-.9 1-1.3 1.9-1.3h1.6c.6 0 1 .4 1 1V16.6c0 1.2-.9 2-2.1 2H4.1c-1.2 0-2-.8-2-2v-3z" fill="${GR}"/><path d="M18.8 9.5l-1.6-5.2c-.3-.9-1-1.3-1.9-1.3h-1.6c-.6 0-1 .4-1 1V16.6c0 1.2.9 2 2.1 2h3.1c1.2 0 2-.8 2-2v-3z" fill="${GR}"/><path d="M9.3 7h3.4v4.6H9.3z" fill="${GR}"/>`,
    ),
  ],
  [
    388,
    T(
      `<path d="M2.2 9l1.4-4.6c.3-.8.9-1.2 1.7-1.2h1.4c.5 0 .9.4.9.9V15c0 1-.8 1.8-1.8 1.8H3c-1 0-1.8-.8-1.8-1.8v-2.6z" fill="${GR}"/><path d="M15.8 9l-1.4-4.6c-.3-.8-.9-1.2-1.7-1.2h-1.4c-.5 0-.9.4-.9.9V15c0 1 .8 1.8 1.8 1.8H15" fill="${GR}"/><path d="M7.6 6.4h3v4.2h-3z" fill="${GR}"/><path d="M16.6 12.2v8.2M12.5 16.3h8.2" stroke="#2AA7E6" stroke-width="2" stroke-linecap="butt"/>`,
    ),
  ],
  [
    423,
    page(
      `<path d="M5.2 19.5V6.2M2.6 8.8l2.6-2.6 2.6 2.6M2.6 12.2l2.6-2.6 2.6 2.6" stroke="${AG}" stroke-width="1.6"/>`,
    ),
  ],
  [450, page(`<path d="M5.2 19.5V5.6M2.4 8.4l2.8-2.8L8 8.4" stroke="${AG}" stroke-width="1.6"/>`)],
  [
    477,
    page(`<path d="M5.2 3.5v13.9M2.4 14.6l2.8 2.8L8 14.6" stroke="${AG}" stroke-width="1.6"/>`),
  ],
  [
    504,
    page(
      `<path d="M5.2 3.5v13.3M2.6 10.8l2.6 2.6 2.6-2.6M2.6 14.2l2.6 2.6 2.6-2.6" stroke="${AG}" stroke-width="1.6"/>`,
    ),
  ],
  [
    539,
    T(
      `<rect x="2.6" y="3.1" width="16.8" height="15.8" fill="#fff" stroke="${GR}" stroke-width="1.1"/><path d="M2.6 3.1h16.8v2.9H2.6z" fill="${GR}"/><path d="M19.4 6v12.9H8" stroke="${GR}" stroke-width="1.6" stroke-linecap="butt"/><path d="M7.6 9.6l1.5 3.05 3.36.49-2.43 2.37.57 3.35-3-1.58-3 1.58.57-3.35-2.43-2.37 3.36-.49z" fill="#F2B11E"/>`,
    ),
  ],
  [
    574,
    circ(
      "#F5B524",
      `<path d="M8.4 8.6c0-1.6 1.2-2.6 2.7-2.6 1.6 0 2.7 1 2.7 2.4 0 1.2-.7 1.8-1.6 2.4-.7.5-1 .9-1 1.8" stroke="#fff" stroke-width="2"/><circle cx="11.2" cy="15.7" r="1.25" fill="#fff"/>`,
    ),
  ],
] as const;

/* ALV application toolbar icons, 18pt. */
const A = (body: string): string => svg(18, 18, body);
const I = "#666666";
const IB = "#1E8FD6";
const DD = svg(7, 4, `<path d="M.5.5L3.5 3.5 6.5.5" stroke="#666" stroke-width="1.1"/>`);
const ALV: readonly (readonly [number, string, boolean] | readonly [number])[] = [
  [
    10,
    A(
      `<path d="M2.5 2.5h9v13h-9z" fill="#fff" stroke="${I}" stroke-width="1.2" stroke-linejoin="miter"/><path d="M4.5 5.5h5M4.5 8h3" stroke="${I}" stroke-width="1.1" stroke-linecap="butt"/><circle cx="11" cy="10.8" r="3.3" fill="#fff" stroke="${IB}" stroke-width="1.5"/><path d="M13.4 13.2l2.8 2.8" stroke="${IB}" stroke-width="2"/>`,
    ),
    false,
  ],
  [
    40,
    A(
      `<path d="M4.5 15.5V3.2M1.8 5.9l2.7-2.7 2.7 2.7" stroke="${IB}" stroke-width="1.5"/><path d="M9.5 4h2.5M9.5 7.7h4.2M9.5 11.4h5.9M9.5 15.1h7.6" stroke="${I}" stroke-width="1.6" stroke-linecap="butt"/>`,
    ),
    false,
  ],
  [
    66,
    A(
      `<path d="M4.5 2.5v12.3M1.8 12.1l2.7 2.7 2.7-2.7" stroke="${IB}" stroke-width="1.5"/><path d="M9.5 4h7.6M9.5 7.7h5.9M9.5 11.4h4.2M9.5 15.1h2.5" stroke="${I}" stroke-width="1.6" stroke-linecap="butt"/>`,
    ),
    false,
  ],
  [92, A(`<path d="M2 3h14l-5.4 6.4v5.8l-3.2 1.6V9.4z" fill="${I}"/>`), true],
  [
    136,
    A(
      `<path d="M14 4.6V2.8H3.6l5.7 6.2-5.7 6.2H14v-1.8" stroke="${I}" stroke-width="1.7" stroke-linecap="butt" stroke-linejoin="miter"/>`,
    ),
    true,
  ],
  [
    172,
    A(
      `<path d="M10.6 4.2V2.8H2.8l4.3 4.6-4.3 4.6h7.8v-1.4" stroke="${I}" stroke-width="1.5" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M9.2 13.4h7.4M9.2 16.1h7.4" stroke="${IB}" stroke-width="1.5" stroke-linecap="butt"/>`,
    ),
    false,
  ],
  [200],
  [
    210,
    A(
      `<path d="M2.5 1.5h7.4l2.6 2.6v4M2.5 1.5v15h6" fill="none" stroke="${I}" stroke-width="1.2" stroke-linejoin="miter"/><path d="M4.5 5h4.5M4.5 7.5h3" stroke="${I}" stroke-width="1.1" stroke-linecap="butt"/><circle cx="11.6" cy="11.4" r="3.3" fill="#fff" stroke="${IB}" stroke-width="1.5"/><path d="M14 13.8l2.6 2.6" stroke="${IB}" stroke-width="2"/>`,
    ),
    false,
  ],
  [
    236,
    A(
      `<path d="M1.5 2.5h12v13h-12z" fill="#fff" stroke="${I}" stroke-width="1.2" stroke-linejoin="miter"/><path d="M1.5 6.2h12M1.5 9.4h12M1.5 12.6h12M5.6 2.5v13M9.6 2.5v13" stroke="${I}" stroke-width=".9" stroke-linecap="butt"/><path d="M1.5 2.5h12v3.7h-12z" fill="#2E9B5A"/><path d="M11.6 11.6h5.4M14.6 9.2l2.4 2.4-2.4 2.4" stroke="${IB}" stroke-width="1.6"/>`,
    ),
    true,
  ],
  [
    272,
    A(
      `<path d="M1.5 4h15v10.5h-15z" fill="#fff" stroke="${I}" stroke-width="1.3" stroke-linejoin="miter"/><path d="M1.8 4.4L9 10.2l7.2-5.8" stroke="${I}" stroke-width="1.3"/>`,
    ),
    false,
  ],
  [
    298,
    A(
      `<path d="M2 16h14.5" stroke="${I}" stroke-width="1.3" stroke-linecap="butt"/><path d="M3.2 9h3v7h-3z" fill="${I}"/><path d="M7.7 4h3v12h-3z" fill="${IB}"/><path d="M12.2 7h3v9h-3z" fill="${I}"/>`,
    ),
    false,
  ],
  [326],
  [
    336,
    A(
      `<path d="M1.5 2.5h15v13h-15z" fill="#fff" stroke="${I}" stroke-width="1.2" stroke-linejoin="miter"/><path d="M1.5 2.5h15v3.2h-15z" fill="${I}"/><path d="M6.5 5.7v9.8M11.5 5.7v9.8" stroke="${I}" stroke-width="1.1" stroke-linecap="butt"/>`,
    ),
    true,
  ],
  [
    372,
    A(
      `<path d="M1.5 2.5h13v13h-13z" fill="#fff" stroke="${I}" stroke-width="1.2" stroke-linejoin="miter"/><path d="M1.5 2.5h13v3.2h-13z" fill="${I}"/><path d="M5.8 5.7v9.8M10.2 5.7v4" stroke="${I}" stroke-width="1.1" stroke-linecap="butt"/><path d="M9.2 16.3l.5-2.4 5.6-5.6 1.9 1.9-5.6 5.6z" fill="${IB}"/>`,
    ),
    false,
  ],
  [
    398,
    A(
      `<path d="M1.5 2.5h13v13h-13z" fill="#fff" stroke="${I}" stroke-width="1.2" stroke-linejoin="miter"/><path d="M1.5 2.5h13v3.2h-13z" fill="${I}"/><path d="M5.8 5.7v9.8M10.2 5.7v3" stroke="${I}" stroke-width="1.1" stroke-linecap="butt"/><path d="M9 9h6.4l1.6 1.6V17H9z" fill="${IB}"/><path d="M10.6 9h3.6v2.4h-3.6z" fill="#fff"/><path d="M10.4 13.4h5v3.6h-5z" fill="#fff"/>`,
    ),
    false,
  ],
  [426],
  [
    436,
    A(
      `<circle cx="9" cy="9" r="7.3" stroke="${IB}" stroke-width="1.5"/><path d="M9 8v5" stroke="${IB}" stroke-width="1.9" stroke-linecap="butt"/><circle cx="9" cy="5.3" r="1.15" fill="${IB}"/>`,
    ),
    false,
  ],
];

/** ICON_YELLOW_LIGHT: a three-lamp housing with the middle lamp lit. */
const light = (): string => {
  const lamp = (cx: number, color: string, lit: boolean): string =>
    `<circle cx="${cx}" cy="5.5" r="3.1" fill="${lit ? color : "#80868D"}"/>`;
  return svg(
    28,
    11,
    `<rect x=".5" y=".5" width="27" height="10" rx="5" fill="#3E4349"/>${lamp(5.5, "#E8312F", false)}${lamp(14, "#F5B30A", true)}${lamp(22.5, "#33B13B", false)}`,
  );
};

const COLS = [
  ["Customer", 70, ""],
  ["Customer Name", 134, ""],
  ["Contact", 124, ""],
  ["Email", 198, ""],
  ["WBS / Project", 172, ""],
  ["Hours", 62, "n"],
  ["Rate", 66, "n"],
  ["Net Amount", 92, "n"],
  ["Curr.", 44, ""],
  ["Bill. Status", 118, ""],
] as const;
const ROWS = [
  [
    "100041",
    "Halcyon Labs",
    "Priya Raman",
    "billing@halcyonlabs.com",
    "Brand system",
    "62.0",
    "150.00",
    "9,300.00",
  ],
  [
    "100058",
    "Brightline Health",
    "Marcus Oyelaran",
    "ap@brightlinehealth.com",
    "Patient portal redesign",
    "84.5",
    "150.00",
    "12,675.00",
  ],
  [
    "100063",
    "Kestrel Robotics",
    "Dana Whitfield",
    "finance@kestrelrobotics.com",
    "Investor deck",
    "41.0",
    "150.00",
    "6,150.00",
  ],
  [
    "100077",
    "Oak &amp; Ember",
    "Tomás Herrera",
    "tomas@oakandember.co",
    "Packaging refresh",
    "28.5",
    "150.00",
    "4,275.00",
  ],
  [
    "100082",
    "Parallel Capital",
    "Wen Li",
    "ops@parallel.capital",
    "Website",
    "57.0",
    "150.00",
    "8,550.00",
  ],
  [
    "100096",
    "Tidewater Co.",
    "Sofia Lindqvist",
    "accounts@tidewater.co",
    "Annual report",
    "50.0",
    "145.00",
    "7,250.00",
  ],
] as const;

const cell = (index: number, html: string, extra = ""): string => {
  const [, width, kind] = COLS[index] ?? COLS[0];
  return `<span class="sp-c${kind ? " is-num" : ""}${index === 0 ? " is-key" : ""}${extra}" style="width:${width}px">${html}</span>`;
};

const row = (data: readonly string[], index: number): string => {
  const brightline = index === 1;
  const cells = data.map((value, at) => {
    if (brightline && at === 5) return cell(at, `<span data-h="sap-hours">${value}</span>`);
    return cell(at, value);
  });
  const status = cell(9, `<span class="sp-st">${light()}Not invoiced</span>`, " sp-status");
  return `<div class="sp-row${index % 2 ? " is-alt" : ""}${brightline ? " sp-row--pick" : ""}"><span class="sp-sel"${brightline ? ' data-h="sap-row"' : ""}></span>${cells.join("")}${cell(8, "USD")}${status}</div>`;
};

const TOTALS = COLS.map((_, at) => {
  const value =
    { 0: '<span class="sp-sigma">Σ</span>', 5: "323.0", 7: "48,200.00", 8: "USD" }[at] ?? "";
  return cell(at, value);
}).join("");

const MENUS = ["List", "Edit", "Goto", "Settings", "System", "Help"];

/** SAP GUI for Java 7.80 on macOS, Blue Crystal theme: the billable-hours ALV report. */
export const sap = `<div class="win sap is-open is-front" data-win="sap" style="left:28px;top:50px;width:1120px;height:660px">
  <div class="sp-titlebar"><span class="tl"><i></i><i></i><i></i></span><b>S4P (1)/100 Billable Hours by Customer</b></div>
  <div class="sp-menubar">${MENUS.map((menu) => `<span>${menu}</span>`).join("")}</div>
  <div class="sp-systb">${STD.map(([x, icon]) => `<i style="left:${x}px"${x === 209 ? ' class="is-off"' : ""}>${icon}</i>`).join("")}<span class="sp-cmd">ZBILL_HOURS</span><span class="sp-cmd-tog">${svg(12, 11, `<path d="M5.4 .9L1.2 5.5l4.2 4.6M10.8 .9L6.6 5.5l4.2 4.6" stroke="#555" stroke-width="1.9" stroke-linecap="butt" stroke-linejoin="miter"/>`)}</span></div>
  <div class="sp-title">Billable Hours by Customer — October 2026</div>
  <div class="sp-apptb">${ALV.map((item) =>
    item.length === 1
      ? `<span class="sp-asep" style="left:${item[0]}px"></span>`
      : `<i class="${item[2] ? "has-dd" : ""}" style="left:${item[0]}px">${item[1]}${item[2] ? DD : ""}</i>`,
  ).join("")}</div>
  <div class="sp-content">
    <div class="sp-info">Company Code 1000 · Period 10/2026 · Status: Not invoiced</div>
    <div class="sp-grid">
      <div class="sp-hrow"><span class="sp-corner">${svg(9, 9, '<path d="M8.5 .5v8h-8z" fill="#9AA3AD"/>')}</span>${COLS.map(([title, width, kind]) => `<span class="sp-hc${kind ? " is-num" : ""}" style="width:${width}px">${title}</span>`).join("")}</div>
      ${ROWS.map((data, index) => row(data, index)).join("")}
      <div class="sp-row sp-total"><span class="sp-sel"></span>${TOTALS}</div>
    </div>
  </div>
  <div class="sp-statusbar"><span class="sp-logo">${SAP_LOGO(37)}</span><span class="sp-sysinfo"><span>${svg(9, 8, '<path d="M1 .8l3.2 3.2L1 7.2M5 .8l3.2 3.2L5 7.2" stroke="#555" stroke-width="1.2" stroke-linecap="butt" stroke-linejoin="miter"/>')}</span><i></i><span>S4P (1) 100</span>${svg(9, 5, '<path d="M.8.8L4.5 4.2 8.2.8" stroke="#666" stroke-width="1.2"/>')}<i></i><span>sapprd01</span><i></i><span>INS</span></span></div>
</div>`;
