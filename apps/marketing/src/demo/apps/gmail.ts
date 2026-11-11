import "./gmail.css";
import type { BrowserTab } from "./browser.js";

const line = (path: string): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICONS = {
  menu: "M3 5.5h14M3 10h14M3 14.5h14",
  search: "M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12.5 12.5 17 17",
  help: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5M10 14.2v.1",
  gear: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6",
  apps: "M5 5h.1M10 5h.1M15 5h.1M5 10h.1M10 10h.1M15 10h.1M5 15h.1M10 15h.1M15 15h.1",
  pencil: "M12.5 4.5 15.5 7.5 7 16H4v-3ZM11 6l3 3",
  inbox: "M3 11h4l1.5 2.5h3L13 11h4M5 4h10l2 7v5H3v-5Z",
  star: "M10 3l2.1 4.4 4.9.6-3.6 3.3 1 4.8L10 13.7 5.6 16.1l1-4.8L3 8l4.9-.6Z",
  clock: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM10 6v4l2.5 2",
  send: "M3.5 10 16.5 4l-4 12-2.5-5ZM10 11l6.5-7",
  file: "M5.5 3h6l3.5 3.5V17h-9.5ZM11.5 3v3.5H15",
  more: "M5 10h.1M10 10h.1M15 10h.1",
  format: "M5 15 9.5 4h1L15 15M6.8 11h6.4",
  clip: "M14.5 9.5 9 15a3.2 3.2 0 0 1-4.5-4.5l6-6a2.1 2.1 0 0 1 3 3l-6 6a1 1 0 0 1-1.5-1.5L11 7",
  link: "M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1-1",
  smile: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM7.3 11.5a3.3 3.3 0 0 0 5.4 0M7.5 8h.1M12.5 8h.1",
  image: "M3.5 4.5h13v11h-13ZM3.5 13l4-4 3 3 2-2 4 4M12.5 7.5h.1",
  trash: "M4.5 6h11M8 6V4h4v2M6 6l.7 10h6.6L14 6",
  refresh: "M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 3.5v3h-3",
  min: "M5 14h10",
  expand: "M11.5 4H16v4.5M8.5 16H4v-4.5M16 4l-5 5M4 16l5-5",
  close: "M5 5l10 10M15 5 5 15",
} as const;

const icon = (name: keyof typeof ICONS): string => line(ICONS[name]);

const MARK = `<svg class="gm-m" viewBox="0 0 24 18" aria-hidden="true"><path d="M2 17V4.5" stroke="#4285f4" stroke-width="3.4" stroke-linecap="round"/><path d="M22 17V4.5" stroke="#34a853" stroke-width="3.4" stroke-linecap="round"/><path d="M2.3 3.2 12 10.5l9.7-7.3" fill="none" stroke="#ea4335" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.4 4.9 21.7 3.2" stroke="#fbbc04" stroke-width="3.4" stroke-linecap="round"/></svg>`;

const TOP = `<header class="gm-top">
  <span class="gm-ico">${icon("menu")}</span>
  <span class="gm-brand">${MARK}<b>Gmail</b></span>
  <span class="gm-search">${icon("search")}Search mail</span>
  <span class="gm-top__end"><span class="gm-ico">${icon("help")}</span><span class="gm-ico">${icon("gear")}</span><span class="gm-ico">${icon("apps")}</span><i class="gm-me">AR</i></span>
</header>`;

const folder = (name: keyof typeof ICONS, label: string, count = "", on = false): string =>
  `<span class="gm-folder${on ? " is-on" : ""}">${icon(name)}<b>${label}</b><em>${count}</em></span>`;

const SIDE = `<aside class="gm-side">
  <span class="gm-compose-btn" data-h="gm-compose-btn">${icon("pencil")}Compose</span>
  ${folder("inbox", "Inbox", "12", true)}${folder("star", "Starred")}${folder("clock", "Snoozed")}${folder("send", "Sent")}${folder("file", "Drafts", "3")}
</aside>`;

const mail = (
  from: string,
  subject: string,
  snippet: string,
  when: string,
  unread = false,
): string =>
  `<div class="gm-row${unread ? " is-unread" : ""}"><i class="gm-box"></i><span class="gm-star">${icon("star")}</span><b>${from}</b><span class="gm-snip"><strong>${subject}</strong> – ${snippet}</span><time>${when}</time></div>`;

const LIST = `<section class="gm-list">
  <div class="gm-tools"><i class="gm-box"></i><span class="gm-ico">${icon("refresh")}</span><span class="gm-ico">${icon("more")}</span><span class="gm-range">1–50 of 2,481</span></div>
  <div class="gm-tabs"><span class="is-on">${icon("inbox")}Primary</span><span>Promotions</span><span>Updates</span></div>
  ${mail("Jordan Lee", "Q4 pipeline review", "Pulled the numbers for Thursday. Acme is the big one", "9:12 AM", true)}
  ${mail("Sam Okafor", "Intro: Delta Supply ops", "Sam here, connecting you with their new COO", "8:47 AM", true)}
  ${mail("Nadia Aziz", "Acme onboarding playbook", "Thanks for the template, we used it for the last", "Nov 9")}
  ${mail("Marcus Bell", "Re: Fieldstone pilot", "Signed and back to you. Kickoff on the 18th works", "Nov 9")}
  ${mail("Imani Brooks", "Seat count for Brooks & Co", "We'd like two more seats starting next month", "Nov 8")}
  ${mail("Theo Park", "October usage report", "Attached is the usage export you asked for", "Nov 7")}
  ${mail("Greta Lind", "Invoice question", "Can you resend October's invoice with our VAT", "Nov 6")}
</section>`;

const COMPOSE = `<div class="gm-compose" data-h="gm-compose">
  <header class="gm-compose__bar"><b data-h="gm-title">New Message</b><span>${icon("min")}${icon("expand")}${icon("close")}</span></header>
  <div class="gm-field gm-field--to" data-h="gm-to-field"><span class="gm-label">To</span><span class="gm-chip"><i>PR</i>Priya Raman</span><span class="gm-typed" data-h="gm-to"></span><span class="gm-cc">Cc Bcc</span>
    <div class="gm-suggest" data-h="gm-suggest"><i>PR</i><div><b>Priya Raman</b><span>priya@acme.example</span></div></div>
  </div>
  <div class="gm-field" data-h="gm-subject-field"><span class="gm-placeholder">Subject</span><span class="gm-typed" data-h="gm-subject"></span></div>
  <div class="gm-body" data-h="gm-body">${["gm-p1", "gm-p2", "gm-p3", "gm-p4", "gm-p5"].map((hook) => `<p class="gm-p" data-h="${hook}"></p>`).join("")}</div>
  <div class="gm-file"><i class="gm-pdf">PDF</i><b>Acme-2027-renewal-quote.pdf</b><em>(84K)</em>${icon("close")}<span class="gm-file__bar"></span></div>
  <footer class="gm-compose__foot"><span class="gm-send" data-h="gm-send"><b>Send</b><i></i><svg viewBox="0 0 10 6" aria-hidden="true"><path d="m1 1 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span><span class="gm-ico">${icon("format")}</span><span class="gm-ico" data-h="gm-clip">${icon("clip")}</span><span class="gm-ico">${icon("link")}</span><span class="gm-ico">${icon("smile")}</span><span class="gm-ico">${icon("image")}</span><span class="gm-saved">Draft saved</span><span class="gm-ico gm-trash">${icon("trash")}</span></footer>
</div>`;

export const gmail: BrowserTab = {
  id: "gmail",
  title: "Inbox (12) - alex@riveraco.com - Gmail",
  url: "mail.google.com<em>/mail/u/0/#inbox</em>",
  mark: `<i class="br-fav" style="background:#fff">${MARK}</i>`,
  page: `<div class="gm">${TOP}<div class="gm-main">${SIDE}${LIST}</div>${COMPOSE}</div>`,
};
