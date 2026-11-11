import "./slack.css";
import { PEOPLE, face, type Person } from "./face.js";

const svg = (inner: string): string => `<svg viewBox="0 0 20 20" aria-hidden="true">${inner}</svg>`;
const path = (d: string): string => svg(`<path d="${d}"/>`);
const solid = (d: string): string => svg(`<path d="${d}" fill="currentColor" stroke="none"/>`);

const I = {
  back: path("M12 4.5 6.5 10l5.5 5.5"),
  forward: path("M8 4.5 13.5 10 8 15.5"),
  history: path("M10 17a7 7 0 1 0-6.6-9.3M3.2 3.8v4h4M10 6.5V10l2.5 1.6"),
  search: path("M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12.5 12.5 16.5 16.5"),
  help: path(
    "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM7.9 7.9a2.2 2.2 0 1 1 3 2c-.6.3-.9.7-.9 1.4M10 13.9v.1",
  ),
  home: path("M3.5 9 10 3.5 16.5 9v7.5h-4.5v-4.5h-4v4.5H3.5Z"),
  dms: path("M3 4.5h10v7H7.5L4.5 14v-2.5H3ZM13 7.5h4v6.5h-1.5v2.2L13 14H9v-2.5"),
  bell: path(
    "M10 3a4.5 4.5 0 0 0-4.5 4.5V11L4 13.5h12L14.5 11V7.5A4.5 4.5 0 0 0 10 3ZM8.3 16a1.8 1.8 0 0 0 3.4 0",
  ),
  more: svg(
    `<circle cx="4.5" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.4" fill="currentColor" stroke="none"/>`,
  ),
  compose: path("M9 4H4.5v11.5H16V11M14.2 3.3l2.5 2.5L10 12.5H7.5V10Z"),
  threads: path("M3.5 4.5h13v8.5H9l-3.5 3v-3h-2ZM6.5 7.5h7M6.5 10h4.5"),
  sent: path("M3.5 10 16.5 4l-4 12-2.5-5ZM10 11l6.5-7"),
  hash: path("M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h13M3.5 12.5h13"),
  caret: path("M6 8l4 4 4-4"),
  headphones: path(
    "M4 13.5V11a6 6 0 0 1 12 0v2.5M4 12h2.5v4.5H5A1 1 0 0 1 4 15.5ZM16 12h-2.5v4.5H15a1 1 0 0 0 1-1Z",
  ),
  bold: path("M6.5 4h4.5a3 3 0 0 1 0 6H6.5ZM6.5 10h5.2a3 3 0 0 1 0 6H6.5Z"),
  italic: path("M9 4h6M5 16h6M12 4 8 16"),
  strike: path(
    "M4 10h12M13.5 6.4c-.5-1.5-1.8-2.3-3.6-2.3-2 0-3.5 1-3.5 2.6 0 .8.4 1.5 1.3 2M6.5 13.6c.5 1.5 1.9 2.3 3.7 2.3 2.1 0 3.5-1 3.5-2.6 0-.5-.1-.9-.4-1.3",
  ),
  link: path(
    "M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1-1",
  ),
  ordered: path(
    "M8.5 5.5h8M8.5 10h8M8.5 14.5h8M3.5 4.5l1.2-.7v3.4M3.4 12.6c.3-.6 1.8-.7 1.8.4 0 .7-1.8 1.5-1.8 2.3h2",
  ),
  bullets: svg(
    `<path d="M8.5 5.5h8M8.5 10h8M8.5 14.5h8"/><circle cx="4.5" cy="5.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/>`,
  ),
  code: path("M7.5 6 3.5 10l4 4M12.5 6l4 4-4 4"),
  block: path("M3.5 4.5h13v11h-13ZM8.5 8 6.5 10l2 2M11.5 8l2 2-2 2"),
  plus: path("M10 5v10M5 10h10"),
  emoji: path(
    "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM7.2 11.6a3.4 3.4 0 0 0 5.6 0M7.6 8.2v.1M12.4 8.2v.1",
  ),
  mention: path(
    "M13 10a3 3 0 1 1-3-3 3 3 0 0 1 3 3v1.1a1.8 1.8 0 0 0 3.6 0V10a6.6 6.6 0 1 0-2.6 5.3",
  ),
  video: path("M3 6.5h9.5v7H3ZM12.5 9 17 6.5v7L12.5 11"),
  mic: path(
    "M10 3a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 10 3ZM5.5 9.5a4.5 4.5 0 0 0 9 0M10 14v3",
  ),
  slash: path(
    "M4 3.5h12a.5.5 0 0 1 .5.5v12a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5ZM12.2 6.5 7.8 13.5",
  ),
  send: solid("M3.2 3.4 17.4 10 3.2 16.6l1.9-5.6L11 10l-5.9-1Z"),
} as const;

const tool = (icon: string): string => `<span class="sl-tool">${icon}</span>`;

const message = (who: string, person: Person, time: string, text: string, extra = ""): string =>
  `<article class="sl-msg${extra}">${face(person, "sl-pic")}<div><b>${who}</b><time>${time}</time><p>${text}</p></div></article>`;

const dm = (name: string, person: Person): string =>
  `<div class="sl-row">${face(person, "sl-pic sl-pic--dm")}<i class="sl-dot"></i>${name}</div>`;

const channel = (name: string, on = false): string =>
  `<div class="sl-row${on ? " is-on" : ""}">${I.hash}${name}</div>`;

const rail = (icon: string, label: string, on = false): string =>
  `<span class="sl-rail__item${on ? " is-on" : ""}"><i>${icon}</i>${label}</span>`;

export const slack = `<div class="win sl" data-win="slack" style="left:120px;top:76px;width:570px;height:440px">
  <div class="sl-top"><span class="tl"><i></i><i></i><i></i></span><span class="sl-nav">${I.back}${I.forward}${I.history}</span><span class="sl-search">${I.search}Search Rivera &amp; Co.</span><span class="sl-help">${I.help}</span></div>
  <div class="sl-body">
    <nav class="sl-rail"><b class="sl-ws">R</b>${rail(I.home, "Home", true)}${rail(I.dms, "DMs")}${rail(I.bell, "Activity")}${rail(I.more, "More")}</nav>
    <aside class="sl-side">
      <h6>Rivera &amp; Co.${I.caret}<span>${I.compose}</span></h6>
      <div class="sl-row">${I.threads}Threads</div><div class="sl-row">${I.sent}Drafts &amp; sent</div>
      <div class="sl-group">${I.caret}Channels</div>
      ${channel("general")}${channel("support", true)}${channel("engineering")}${channel("sales")}
      <div class="sl-group">${I.caret}Direct messages</div>
      ${dm("Maya Chen", PEOPLE.maya)}${dm("Sam Okafor", PEOPLE.sam)}
    </aside>
    <section class="sl-main">
      <header><b>${I.hash}support${I.caret}</b><span class="sl-members">${face(PEOPLE.maya, "sl-pic")}${face(PEOPLE.sam, "sl-pic")}12</span><span class="sl-huddle">${I.headphones}${I.caret}</span></header>
      <nav class="sl-tabs"><span class="is-on">Messages</span><span>Canvas</span><span>Files</span><span>${I.plus}</span></nav>
      <div class="sl-thread">
        ${message("Maya Chen", PEOPLE.maya, "9:12 AM", "Heads up: Northwind renews next month. Let's keep them happy.")}
        ${message("Sam Okafor", PEOPLE.sam, "9:30 AM", "Queue is at 6 open tickets. I'm on the two SSO ones.")}
        ${message("Alex Rivera", PEOPLE.alex, "9:43 AM", `<span data-h="sl-posted"></span>`, " sl-msg--new")}
      </div>
      <div class="sl-composer">
        <div class="sl-format">${[I.bold, I.italic, I.strike].map(tool).join("")}<i></i>${tool(I.link)}<i></i>${[I.ordered, I.bullets].map(tool).join("")}<i></i>${[I.code, I.block].map(tool).join("")}</div>
        <p data-h="sl-compose"></p>
        <div class="sl-actions"><span class="sl-tool sl-plus">${I.plus}</span><span class="sl-tool sl-aa">Aa</span>${tool(I.emoji)}${tool(I.mention)}<i></i>${tool(I.video)}${tool(I.mic)}<i></i>${tool(I.slash)}<span class="sl-send">${I.send}<i></i>${I.caret}</span></div>
      </div>
    </section>
  </div>
</div>`;
