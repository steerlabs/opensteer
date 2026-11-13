import "./styles/team.css";
import { byId, find, icon, restart } from "./dom.js";

interface Person {
  readonly name: string;
  readonly first: string;
  readonly color: string;
}

const MAYA: Person = { name: "Maya Chen", first: "Maya", color: "#c58af9" };
const LEO: Person = { name: "Leo Park", first: "Leo", color: "#84b5e0" };
const PRIYA: Person = { name: "Priya Shah", first: "Priya", color: "#dfb36b" };

const mark = (person: Person, agent = false): string =>
  `<span class="mark${agent ? " mark--agent" : ""}" style="--c:${person.color}">${person.first[0]}</span>`;

const chip = (label: string): string => `<span class="tchip">@${label}</span>`;

function message(person: Person, time: string, body: string): string {
  return `<div class="tm">${mark(person)}<div class="tm__body"><div class="tm__who"><b>${person.name}</b><time>${time}</time></div><div class="tm__text">${body}</div></div></div>`;
}

/** An agent's finished post: its owner's face with the agent badge, its status, then the answer and the topic it used. */
const AGENT_POST = `<div class="tm tm--agent">${mark(LEO, true)}<div class="tm__body"><div class="tm__who"><b>Leo's agent</b><span class="tm__badge">Agent</span><time>2:41 PM</time></div>
  <div class="tcard" data-state="done">
    <div class="tcard__top"><span class="tcard__spin"></span><b>Done</b><span class="tcard__meta">4 steps · 1m 12s</span><span class="tcard__open">Open task</span></div>
  </div>
  <div class="tm__text tm__answer">Submitted LUMEN-0142 for $9,300.00 against PO 4500018871 in Halcyon's Coupa portal. The hours match SAP, and the $150 rate matches their contract.<span class="tsource">${icon("t-doc")}Client contracts</span></div></div></div>`;

const channel = (name: string, extra = ""): string =>
  `<div class="tw-row${extra}"><span class="tw-hash">#</span>${name}</div>`;

const TOPICS = [
  { name: "Billing policy", about: "Rates, terms and approvals", who: "Everyone", leo: true },
  { name: "Client contracts", about: "SOWs, POs and portals", who: "Finance, Leads", leo: true },
  { name: "Salaries", about: "Pay bands and offers", who: "Maya, Priya", leo: false },
] as const;

const WINDOW = `<div class="tw">
  <aside class="tw-side">
    <div class="tw-lights"><i></i><i></i><i></i></div>
    <div class="tw-brand"><b>Opensteer</b><span>${icon("i-mic")}${icon("m-search")}${icon("m-plus")}</span></div>
    <div class="tw-switch"><span class="tw-seg">Tasks</span><span class="tw-seg is-on"><span class="tw-team">L</span>Lumen</span></div>
    <div class="tw-label">Channels</div>
    ${channel("announcements")}
    ${channel("general")}
    ${channel("brightline", " is-unread")}
    ${channel("billing", " is-on")}
    <div class="tw-row"><span class="tw-hash">${icon("i-lock")}</span>leadership</div>
    <div class="tw-label">Direct messages</div>
    <div class="tw-row is-unread">${mark(MAYA)}Maya Chen<span class="tw-count">1</span></div>
    <div class="tw-row">${mark(PRIYA)}Priya Shah</div>
    <div class="tw-foot"><b>Leo's MacBook</b><span><i></i>Connected · Lumen</span></div>
  </aside>
  <div class="tw-main">
    <header class="tw-head"><b>Thread</b><span># billing</span><span class="tw-people">${mark(MAYA)}${mark(LEO)}${mark(PRIYA)}<em>14</em></span></header>
    <div class="tw-feed">${message(MAYA, "2:36 PM", "Halcyon's AP says invoices have to go through their Coupa portal now, not email. Can someone send October's?")}${message(LEO, "2:41 PM", `${chip("My agent")} submit LUMEN-0142 in Halcyon's portal if it matches the PO`)}${AGENT_POST}</div>
    <div class="tw-compose">
      <div class="tw-input"></div>
      <div class="tw-tools"><span>@</span><span class="tw-ask"><span class="orb"></span>Ask my agent</span><span class="tw-send">${icon("i-up")}</span></div>
    </div>
  </div>
  <aside class="tw-know">
    <header class="tw-head"><b>Knowledge</b></header>
    <div class="topics-head"><span>Topic</span><span>Who can read</span></div>
    <div data-part="topics"></div>
    <p class="knote" data-part="note">${icon("i-shield")}<span>Leo's agent reads what Leo can, and nothing more.</span></p>
  </aside>
</div>`;

/** One #billing thread in the team view, beside the team's knowledge: who can read each topic, and so whose agents can. */
export function mountTeam(): void {
  const root = byId("teamStage");
  root.innerHTML = WINDOW;
  const list = find(root, '[data-part="topics"]');
  const note = find(root, '[data-part="note"]');
  TOPICS.forEach((topic) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "topic";
    row.setAttribute("aria-pressed", "false");
    row.innerHTML = `<span class="topic__name"><b>${topic.name}</b><small>${topic.about}</small></span><span class="topic__who">${topic.who}</span>`;
    row.addEventListener("click", () => {
      for (const other of list.querySelectorAll(".topic"))
        other.setAttribute("aria-pressed", "false");
      row.setAttribute("aria-pressed", "true");
      find(note, "span").textContent = topic.leo
        ? `Leo can read ${topic.name}, so his agent can look it up and keep it current.`
        : `Leo can't read ${topic.name}, so neither can his agent.`;
      restart(note, "is-flash");
    });
    list.appendChild(row);
  });
}
