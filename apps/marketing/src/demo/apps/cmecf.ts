import "./cmecf.css";
import type { BrowserTab } from "./browser.js";

/* The scales the district courts' CM/ECF sites serve as their favicon. */
const FAVICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAAAQoAMABAAAAAEAAAAQAAAAADRVcfIAAACvSURBVDgRlVFbDsMwCGuq/e/KXLk3GCBMCHPWNVIbbMwz4/h93uG+4gY26NwZjrvLAhF8iUjqX2lNA8LJRLVKMBtVagJwqdfq7sedI0RbNhfmzaC/DGRs4qWDrjHsHZihny2ntt9ycciWyJXG6vZlvoZj5daqDa8jaLAlqF8uUfPfHmkLNjz09zV3EcK3fZlHHRzknKWauzsmMY+oZYkscjAyOMwPCd3DLkEP3ib5AMKfKkUE0ALVAAAAAElFTkSuQmCC";

/** CM/ECF's logo: the letters, and the gold courthouse between them. */
const LOGO = `<span class="ecf-logo">CM<svg viewBox="0 0 30 26" aria-hidden="true"><path d="M15 1 1.5 7.5h27Z" fill="#c9ad6e"/><path d="M3 8.5h24v2H3z" fill="#c9ad6e"/><path d="M6 11.5h3v10H6zM13.5 11.5h3v10h-3zM21 11.5h3v10h-3z" fill="#c9ad6e"/><path d="M2 22h26v3H2z" fill="#c9ad6e"/></svg>ECF</span>`;
const MENU = `<header class="ecf-head">${LOGO}<nav><span><u>Q</u>uery</span><span><u>R</u>eports<i></i></span><span><u>U</u>tilities<i></i></span><span>Help</span><span>What's New</span><span>Log Out</span></nav></header>`;

const CASE = "3:26-cv-04417-EMH";
const TITLE = "Lumen Studio LLC v. Ardent Media Group, Inc.";

const field = (label: string, input: string): string =>
  `<div class="ecf-f"><label>${label}</label>${input}</div>`;
const box = (width: number, hook = ""): string =>
  `<span class="ecf-in" style="width:${width}px"${hook ? ` data-h="${hook}"` : ""}></span>`;
const list = (items: readonly string[]): string =>
  `<span class="ecf-list">${items.map((item) => `<span>${item}</span>`).join("")}</span>`;

const QUERY = `<section class="ecf-p ecf-p--query">
  <h4 class="ecf-q">Query</h4>
  <p class="ecf-warn">WARNING: Search results from this screen are NOT subject to the 30 page limit on PACER charges. Please be as specific as possible with your search criteria.</p>
  <div class="ecf-clues">
    <div class="ecf-clues__bar"><b>Search Clues</b><u>Mobile Query</u></div>
    <div class="ecf-clues__body">
      ${field("Case Number", `<span class="ecf-in" style="width:156px" data-h="ecf-case-field"><span data-h="ecf-case"></span></span>`)}
      ${field("Search by Last / Business Name", box(156))}
      <div class="ecf-row">${field("First Name", box(120))}${field("Middle Name", box(120))}</div>
      <div class="ecf-row"><span class="ecf-check"><i></i>Exact matches only</span>${field("Type", `<span class="ecf-sel" style="width:150px">All</span>`)}</div>
      <div class="ecf-row">${field("Filed Date", `${box(92)} to ${box(92)}`)}${field("Last Entry Date", `${box(92)} to ${box(92)}`)}</div>
      <div class="ecf-row ecf-row--lists">${field("Nature of Suit", list(["0 (zero)", "110 (Insurance)", "120 (Marine)", "130 (Miller Act)"]))}${field("Cause of Action", list(["0 (No cause code entered)", "02:0431 (Fed. Election Commission: Failure Enforce C)", "05:0552 (Freedom of Information Act)"]))}</div>
    </div>
  </div>
  <div class="ecf-buttons"><span class="ecf-btn" data-h="ecf-run">Run Query</span><span class="ecf-btn">Clear</span></div>
</section>`;

const LINKS = [
  "Alias",
  "Associated Cases",
  "Attorney",
  "Case File Location...",
  "Case Summary",
  "Deadlines/Hearings...",
  "Docket Report ...",
  "Filers",
  "History/Documents...",
  "Party",
  "Related Transactions...",
  "Status",
  "View a Document",
];
const CASE_MENU = `<section class="ecf-p ecf-p--menu">
  <div class="ecf-casehead"><b>${CASE} ${TITLE}</b><span>Judge Ellen M. Hartwell, presiding</span><span>Date filed: 06/22/2026</span><span>Date of last filing: 11/16/2026</span></div>
  <h5>Query</h5>
  <div class="ecf-links">${LINKS.map((link) => `<u${link.startsWith("Docket") ? ' data-h="ecf-docket-link"' : ""}>${link}</u>`).join("")}</div>
</section>`;

const ENTRIES = [
  [
    "10/02/2026",
    "36",
    "FIRST AMENDED COMPLAINT against Ardent Media Group, Inc.. Filed by Lumen Studio LLC. (Brooks, Alana) (Filed on 10/2/2026)",
  ],
  [
    "10/14/2026",
    "37",
    "STIPULATION WITH PROPOSED ORDER to Extend Time to Respond to First Amended Complaint filed by Ardent Media Group, Inc.. (Osei, Daniel) (Filed on 10/14/2026)",
  ],
  [
    "10/16/2026",
    "38",
    "ORDER GRANTING 37 STIPULATION. Signed by Judge Ellen M. Hartwell on 10/16/2026. (emhlc1, COURT STAFF) (Filed on 10/16/2026)",
  ],
  [
    "10/28/2026",
    "39",
    "CLERK'S NOTICE Continuing Initial Case Management Conference. Initial Case Management Conference set for 1/13/2027 01:30 PM in San Francisco, - Videoconference Only. (emhlc1, COURT STAFF) (Filed on 10/28/2026)",
  ],
  [
    "11/05/2026",
    "40",
    "NOTICE of Appearance by Mira Patel on behalf of Ardent Media Group, Inc. (Patel, Mira) (Filed on 11/5/2026)",
  ],
  [
    "11/12/2026",
    "41",
    "MOTION to Dismiss First Amended Complaint for Failure to State a Claim filed by Ardent Media Group, Inc.. Motion Hearing set for 12/17/2026 10:00 AM in San Francisco, Courtroom 08, 19th Floor before Judge Ellen M. Hartwell. Responses due by 11/26/2026. Replies due by 12/3/2026. (Osei, Daniel) (Filed on 11/12/2026)",
  ],
  [
    "11/12/2026",
    "42",
    "DECLARATION of Rachel Imbert in Support of 41 MOTION to Dismiss First Amended Complaint filed by Ardent Media Group, Inc.. (Osei, Daniel) (Filed on 11/12/2026)",
  ],
  [
    "11/16/2026",
    "43",
    "ADR CERTIFICATION (ADR L.R. 3-5 b) of discussion of ADR options (Osei, Daniel) (Filed on 11/16/2026)",
  ],
] as const;

const DOCKET = `<section class="ecf-p ecf-p--docket">
  <div class="ecf-flags">ADRMOP</div>
  <div class="ecf-court"><b>U.S. District Court</b><b>California Northern District (San Francisco)</b><b>CIVIL DOCKET FOR CASE #: ${CASE}</b></div>
  <div class="ecf-facts">
    <div>${TITLE}<br>Assigned to: Judge Ellen M. Hartwell<br>Cause: 17:501 Copyright Infringement</div>
    <div>Date Filed: 06/22/2026<br>Jury Demand: Plaintiff<br>Nature of Suit: 820 Copyright<br>Jurisdiction: Federal Question</div>
  </div>
  <div class="ecf-party"><div><u><b>Plaintiff</b></u><br><b>Lumen Studio LLC</b></div><div>represented by <b>Alana Brooks</b><br>Brooks Kaminski LLP<br>500 Sansome Street, Suite 1400<br>San Francisco, CA 94111<br><i>ATTORNEY TO BE NOTICED</i></div></div>
  <div class="ecf-party"><div>V.<br><u><b>Defendant</b></u><br><b>Ardent Media Group, Inc.</b></div><div>represented by <b>Daniel Osei</b><br>Harlow &amp; Finch LLP<br>101 California Street, 32nd Floor<br>San Francisco, CA 94111<br><i>LEAD ATTORNEY</i></div></div>
  <table class="ecf-dkt"><tr><th>Date Filed</th><th>#</th><th></th><th>Docket Text</th></tr>${ENTRIES.map(
    ([date, number, text]) =>
      `<tr><td>${date}</td><td><u>${number}</u></td><td><i class="ecf-box" data-h="ecf-box-${number}"></i></td><td>${text}</td></tr>`,
  ).join("")}</table>
  <div class="ecf-multi"><span class="ecf-btn">View Selected</span><span>or</span><span class="ecf-btn" data-h="ecf-download">Download Selected</span></div>
</section>`;

const receipt = (description: string, pages: number, cost: string): string =>
  `<table class="ecf-receipt"><tr><th colspan="4" class="ecf-psc">PACER Service Center</th></tr><tr><th colspan="4">Transaction Receipt</th></tr><tr><td colspan="4" class="ecf-when">11/17/2026 09:47:05</td></tr><tr><th>PACER Login:</th><td>lumenstudio</td><th>Client Code:</th><td>ardent</td></tr><tr><th>Description:</th><td>${description}</td><th>Case Number:</th><td>${CASE}</td></tr><tr><th>Billable Pages:</th><td>${pages}</td><th>Cost:</th><td>${cost}</td></tr></table>`;

const BILL = `<section class="ecf-p ecf-p--bill">
  <p>To accept charges shown below, click on 'Download Documents', otherwise click the 'Back' button on your browser.</p>
  <p class="ecf-total">Total Pages: 30<br>Total Cost: 3.00</p>
  <span class="ecf-btn" data-h="ecf-accept">Download Documents</span>
  <hr>${receipt("Image41-0", 18, "1.80")}<hr>${receipt("Image42-0", 9, "0.90")}<hr>${receipt("Image43-0", 3, "0.30")}
</section>`;

const url = (path: string, step: string): string =>
  `<span class="ecf-u ecf-u--${step}">ecf.cand.uscourts.gov<em>${path}</em></span>`;

/** CM/ECF for the Northern District of California, signed in to PACER: query, the case, its docket and the charge to download. */
export const cmecf: BrowserTab = {
  id: "cmecf",
  title: "CAND-ECF",
  url:
    url("/cgi-bin/iquery.pl", "query") +
    url("/cgi-bin/iquery.pl?412873620984752-L_1_0-1", "menu") +
    url("/cgi-bin/DktRpt.pl?412873", "docket") +
    url("/cgi-bin/show_multidocs.pl?caseid=412873&amp;arr_de_seq_nums=93,94,96", "bill"),
  mark: `<img class="br-fav" src="${FAVICON}" alt="">`,
  page: `<div class="ecf"><div class="ecf-doc">${MENU}${QUERY}${CASE_MENU}${DOCKET}${BILL}</div></div>`,
};

/** The same court's Query page, signed in. */
export const cmecfQuery: BrowserTab = {
  id: "cmecf-home",
  title: "CAND-ECF",
  url: url("/cgi-bin/iquery.pl", "query"),
  mark: `<img class="br-fav" src="${FAVICON}" alt="">`,
  page: `<div class="ecf">${MENU}${QUERY}</div>`,
};
