import "./styles/team.css";
import { byId, find, icon, reducedMotion, restart } from "./dom.js";

/*
 * The team section is a small working model of Opensteer's team view, seen from Leo's Mac.
 * A scripted story plays through the same send path a visitor uses; the first real click or
 * keypress inside the window hands the visitor the controls.
 */

type Who = "leo" | "maya" | "priya";
interface Person {
  readonly name: string;
  readonly first: string;
  readonly color: string;
}
const PEOPLE: Record<Who, Person> = {
  leo: { name: "Leo Park", first: "Leo", color: "#84b5e0" },
  maya: { name: "Maya Chen", first: "Maya", color: "#c58af9" },
  priya: { name: "Priya Shah", first: "Priya", color: "#dfb36b" },
};
const ME: Who = "leo";

type RunState = "working" | "needs" | "done" | "stopped";
interface Ask {
  readonly card: string;
  readonly phone: string;
}
interface Plan {
  readonly title: string;
  readonly steps: readonly string[];
  readonly ask?: Ask;
  readonly after?: readonly string[];
  readonly answer: string;
  readonly denied?: string;
  readonly source?: string;
  readonly allowed?: () => void;
}
interface Run {
  readonly id: string;
  readonly owner: Who;
  readonly plan: Plan;
  readonly task: string | undefined;
  readonly scripted: boolean;
  state: RunState;
  steps: string[];
  stepAt: number;
  answer?: string;
  answerAt: number;
  started: number;
  took: string;
  asking: boolean;
}
interface Msg {
  readonly id: string;
  readonly who: Who;
  readonly agent: boolean;
  readonly time: string;
  readonly body: string;
  readonly run?: string;
  note?: string;
  readonly replies: string[];
}
interface Conv {
  readonly id: string;
  readonly name: string;
  readonly kind: "channel" | "dm";
  readonly topic: string;
  readonly peopleOnly?: boolean;
  readonly with?: Who;
  readonly top: string[];
  unread: number;
  typing?: Who | undefined;
}
type Entry =
  | { readonly kind: "you"; readonly text: string; readonly where?: string }
  | { readonly kind: "run"; readonly run: string };
interface Task {
  readonly id: string;
  readonly title: string;
  readonly entries: Entry[];
  readonly origin?: { readonly conv: string; readonly root: string } | undefined;
  read: boolean;
  readonly created: number;
}
interface Where {
  readonly conv: string;
  readonly root?: string | undefined;
}
type Pane =
  | { readonly k: "conv"; readonly id: string }
  | { readonly k: "thread"; readonly conv: string; readonly root: string }
  | { readonly k: "task"; readonly id: string }
  | { readonly k: "home" }
  | { readonly k: "all" };

interface Model {
  convs: Map<string, Conv>;
  msgs: Map<string, Msg>;
  runs: Map<string, Run>;
  tasks: Map<string, Task>;
  side: "tasks" | "team";
  pane: Pane;
  mobile: "side" | "main";
  refunded: boolean;
  minute: number;
  seq: number;
}

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const mark = (who: Who, agent = false): string =>
  `<span class="mark${agent ? " mark--agent" : ""}" style="--c:${PEOPLE[who].color}">${PEOPLE[who].first[0]}</span>`;

/* ---------- Mentions ---------- */

type Part =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "agent"; readonly who: Who }
  | { readonly t: "person"; readonly who: Who };

const HANDLES: ReadonlyArray<readonly [string, (author: Who) => Part]> = [
  ["my agent", (author) => ({ t: "agent", who: author })],
  ...(["leo", "maya", "priya"] as const).flatMap(
    (who): ReadonlyArray<readonly [string, (author: Who) => Part]> => [
      [`${who}'s agent`, () => ({ t: "agent", who })],
      [`${who}-agent`, () => ({ t: "agent", who })],
      [PEOPLE[who].name.toLowerCase(), () => ({ t: "person", who })],
      [who, () => ({ t: "person", who })],
    ],
  ),
];
const HANDLE = new RegExp(
  `@(${[...HANDLES]
    .map(([label]) => label)
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\w-])`,
  "gi",
);

function parse(text: string, author: Who): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const match of text.matchAll(HANDLE)) {
    const index = match.index ?? 0;
    if (index > at) parts.push({ t: "text", v: text.slice(at, index) });
    const found = HANDLES.find(([label]) => label === match[1]?.toLowerCase());
    if (found) parts.push(found[1](author));
    at = index + match[0].length;
  }
  if (at < text.length) parts.push({ t: "text", v: text.slice(at) });
  return parts;
}

/** Renders a message body as Leo sees it: his own agent is "My agent", anyone else's is named. */
function richText(parts: readonly Part[], author: Who, inert: boolean): string {
  return parts
    .map((part) => {
      if (part.t === "text") return esc(part.v);
      if (part.t === "person")
        return `<span class="tchip tchip--person">@${PEOPLE[part.who].name}</span>`;
      const label = part.who === ME ? "My agent" : `${PEOPLE[part.who].first}'s agent`;
      const live = part.who === author && !inert;
      return `<span class="tchip${live ? "" : " tchip--inert"}">@${label}</span>`;
    })
    .join("");
}

const plain = (parts: readonly Part[]): string =>
  parts
    .filter((part): part is { t: "text"; v: string } => part.t === "text")
    .map((part) => part.v)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/* ---------- What an agent does with a request ---------- */

const REFUND_ANSWER =
  "Refunded the duplicate $480.00 on invoice 2291. It's within policy: duplicates under $1,000 don't need finance. Northwind will see it in 5 to 10 days.";

function sentence(text: string): string {
  const cut = text.replace(/<[^>]+>/g, "").split(/(?<=[.?!])\s/)[0] ?? "";
  return cut.length > 90 ? `${cut.slice(0, 88)}…` : cut;
}

function planFor(ask: string, model: Model, context: readonly Msg[], where: string): Plan {
  const text = ask.toLowerCase();
  if (/refund|stripe|charge|invoice|billing/.test(text)) {
    if (model.refunded)
      return {
        title: "Check Northwind's refund",
        steps: ["Read the thread", "Checked invoice 2291 in Stripe"],
        answer:
          "Already done. The duplicate $480.00 on invoice 2291 was refunded earlier today, so Northwind is square.",
      };
    return {
      title: "Refund Northwind's duplicate charge",
      steps: [
        "Read the thread",
        "Found two $480.00 charges for invoice 2291 in Stripe",
        "Checked the Refund policy topic",
      ],
      ask: {
        card: "Refund <b>$480.00</b> to Northwind?",
        phone: "Refund $480.00 to Northwind for the duplicate charge on invoice 2291?",
      },
      after: ["Refunded $480.00 in Stripe"],
      answer: REFUND_ANSWER,
      denied: "Okay, I didn't refund anything. The duplicate $480.00 is still on invoice 2291.",
      source: "Refund policy",
      allowed: () => {
        model.refunded = true;
      },
    };
  }
  if (/summar|recap|tl;?dr|catch me up|what happened|what's going on/.test(text)) {
    const lines = context
      .filter((msg) => msg.body || msg.run)
      .slice(-5)
      .map((msg) => {
        const run = msg.run ? model.runs.get(msg.run) : undefined;
        const said = run ? (run.answer ?? `working on “${esc(run.plan.title)}”`) : msg.body;
        const who = msg.agent ? `${PEOPLE[msg.who].first}'s agent` : PEOPLE[msg.who].first;
        return `<li><b>${who}:</b> ${sentence(said)}</li>`;
      });
    return {
      title: `Summarize ${where}`,
      steps: [`Read ${where}`, "Pulled out who's doing what"],
      answer: lines.length
        ? `Here's where ${where} stands:<ul>${lines.join("")}</ul>`
        : "Nothing to summarize here yet. Ask me from a channel or a thread and I'll read it.",
    };
  }
  if (/draft|reply to|respond|email|write back|answer/.test(text))
    return {
      title: "Reply to Dana at Northwind",
      steps: ["Read the thread", "Wrote a reply in Gmail from support@acme.com"],
      ask: {
        card: "Send the reply to <b>Dana at Northwind</b>?",
        phone: "Send your reply to Dana at Northwind from support@acme.com?",
      },
      after: ["Sent the reply in Gmail"],
      answer:
        "Sent: “Hi Dana, you're right, invoice 2291 was charged twice. We've refunded the extra $480.00, and it'll reach your card in 5 to 10 days. Sorry for the trouble.”",
      denied: "Kept it as a draft in Gmail. Nothing was sent.",
    };
  if (/linear|issue|bug|ticket|jira/.test(text))
    return {
      title: "File the duplicate-charge bug",
      steps: ["Searched Linear for duplicates", "Created SUP-142 and linked this thread"],
      answer:
        "Filed <b>SUP-142</b> “Retried invoices can charge twice” in Linear, assigned to Payments, with this thread linked.",
    };
  if (/hubspot|crm|note|log/.test(text))
    return {
      title: "Log it on Northwind in HubSpot",
      steps: ["Opened Northwind in HubSpot"],
      answer: "Added a note to Northwind: duplicate charge on invoice 2291, refunded today.",
    };
  if (/meet|call|calendar|schedule|book|sync/.test(text))
    return {
      title: "Book a sync with Maya and Priya",
      steps: ["Checked Maya's and Priya's calendars"],
      answer: "Booked 30 minutes with Maya and Priya tomorrow at 10:00 AM. The invites are out.",
    };
  return {
    title:
      ask.length > 44 ? `${ask.slice(0, 42).trim()}…` : ask.charAt(0).toUpperCase() + ask.slice(1),
    steps: ["Read the request"],
    answer:
      "This page is only a demo, so I can't do that here. On your Mac I would. Here, try asking me to summarize this thread, draft a reply to Northwind, or file a Linear issue.",
  };
}

/* ---------- The world on load ---------- */

function seed(): Model {
  const model: Model = {
    convs: new Map(),
    msgs: new Map(),
    runs: new Map(),
    tasks: new Map(),
    side: "team",
    pane: { k: "home" },
    mobile: "main",
    refunded: false,
    minute: 41,
    seq: 0,
  };
  const conv = (c: Omit<Conv, "top" | "unread"> & { unread?: number }): Conv => {
    const made: Conv = { top: [], unread: 0, ...c };
    model.convs.set(made.id, made);
    return made;
  };
  const say = (where: Conv, who: Who, time: string, body: string): Msg => {
    const msg: Msg = { id: `m${(model.seq += 1)}`, who, agent: false, time, body, replies: [] };
    model.msgs.set(msg.id, msg);
    where.top.push(msg.id);
    return msg;
  };
  const announcements = conv({
    id: "announcements",
    name: "announcements",
    kind: "channel",
    topic: "Company news",
  });
  say(announcements, "priya", "Mon", "The offsite is Thursday the 20th 🎉 The agenda is in Docs.");
  const general = conv({
    id: "general",
    name: "general",
    kind: "channel",
    topic: "Anything and everything",
  });
  say(general, "leo", "12:02 PM", "Lunch order goes in at 12:15. Thai or Mediterranean?");
  say(general, "maya", "12:04 PM", "Thai, always");
  const launch = conv({
    id: "launch",
    name: "launch",
    kind: "channel",
    topic: "2.4 ships Thursday",
    unread: 1,
  });
  say(
    launch,
    "priya",
    "1:48 PM",
    "Checkout QA is the last thing blocking 2.4. Who's taking the payment edge cases?",
  );
  const support = conv({
    id: "support",
    name: "support",
    kind: "channel",
    topic: "Customer issues, newest first",
  });
  say(
    support,
    "leo",
    "2:10 PM",
    "Shopify's refund API is flaky this morning. Use store credit if it fails.",
  );
  say(
    support,
    "maya",
    "2:36 PM",
    "Northwind says they were charged twice for invoice 2291. Can someone take a look?",
  );
  const leadership = conv({
    id: "leadership",
    name: "leadership",
    kind: "channel",
    topic: "Private",
    peopleOnly: true,
  });
  say(
    leadership,
    "priya",
    "11:20 AM",
    "Comp review moves to next week. Numbers are in the Salaries topic.",
  );
  const maya = conv({
    id: "dm-maya",
    name: "Maya Chen",
    kind: "dm",
    topic: "",
    with: "maya",
    unread: 1,
  });
  say(maya, "maya", "1:15 PM", "Can you look at the Q4 vendor invoices before Friday?");
  const priya = conv({ id: "dm-priya", name: "Priya Shah", kind: "dm", topic: "", with: "priya" });
  say(priya, "priya", "Yesterday", "Thanks for jumping on the Acme renewal!");
  return model;
}

/* ---------- Static pieces of the window ---------- */

const SHELL = `<div class="tw" data-pane="main" role="group" aria-label="Interactive demo of Opensteer team channels">
  <aside class="tw-side" data-part="side"></aside>
  <div class="tw-main" data-part="main">
    <header class="tw-head" data-part="head"></header>
    <div class="tw-feed" data-part="feed"></div>
    <div class="tw-compose" data-part="compose">
      <div class="tw-pop" data-part="pop" role="listbox" aria-label="Mention someone"></div>
      <div class="tw-hints" data-part="hints"></div>
      <input class="tw-field" data-part="field" type="text" autocomplete="off" spellcheck="false" aria-label="Message" />
      <div class="tw-tools"><span class="tw-at">@</span><button type="button" class="tw-ask" data-act="ask-toggle" aria-pressed="false"><span class="orb"></span>Ask my agent</button><button type="button" class="tw-send" data-act="send" aria-label="Send">${icon("i-up")}</button></div>
    </div>
  </div>
  <div class="tphone" data-part="phone" aria-live="polite"></div>
</div>`;

const MENU: ReadonlyArray<{
  readonly label: string;
  readonly html: string;
  readonly hint?: string;
  readonly match: string;
}> = [
  {
    label: "My agent",
    html: `<span class="orb"></span><b>My agent</b>`,
    hint: "Works on your MacBook",
    match: "my agent leo",
  },
  { label: "Maya Chen", html: `${mark("maya")}<b>Maya Chen</b>`, match: "maya chen" },
  { label: "Priya Shah", html: `${mark("priya")}<b>Priya Shah</b>`, match: "priya shah" },
  {
    label: "Maya's agent",
    html: `${mark("maya", true)}<b>Maya's agent</b>`,
    hint: "Only Maya can ask it",
    match: "maya's agent",
  },
  {
    label: "Priya's agent",
    html: `${mark("priya", true)}<b>Priya's agent</b>`,
    hint: "Only Priya can ask it",
    match: "priya's agent",
  },
];

const TOPICS = [
  { name: "Refund policy", where: "#support", peopleOnly: false },
  { name: "Pricing", where: "Shared", peopleOnly: false },
  { name: "Salaries", where: "#leadership", peopleOnly: true },
] as const;

function knowledge(): void {
  const list = byId("topics");
  const note = byId("topicNote");
  TOPICS.forEach((topic) => {
    const row = document.createElement("div");
    row.className = "topic";
    row.innerHTML = `<span class="topic__name"><b>${topic.name}</b><small>${topic.where}</small></span><button class="switch" type="button" role="switch" aria-checked="${topic.peopleOnly}" aria-label="${topic.name}: people only"></button>`;
    const toggle = find<HTMLButtonElement>(row, ".switch");
    toggle.addEventListener("click", () => {
      const on = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(on));
      find(note, "span").textContent = on
        ? `Only people can open ${topic.name}. Agents can't read or search it.`
        : `Agents can look up ${topic.name} for anyone who can see it.`;
      restart(note, "is-flash");
    });
    list.appendChild(row);
  });
}

/** Keeps unchanged rows in place so typing, hovers and running animations survive an update. */
const drawn = new WeakMap<Element, string>();
function patch(
  root: Element,
  items: ReadonlyArray<readonly [string, string]>,
  animate: boolean,
): void {
  const old = new Map<string, Element>();
  for (const el of Array.from(root.children)) old.set((el as HTMLElement).dataset.key ?? "", el);
  const template = document.createElement("template");
  let prev: Element | null = null;
  for (const [key, html] of items) {
    let el = old.get(key);
    old.delete(key);
    if (!el || drawn.get(el) !== html) {
      template.innerHTML = html;
      const next = template.content.firstElementChild;
      if (!next) continue;
      (next as HTMLElement).dataset.key = key;
      drawn.set(next, html);
      if (el) el.replaceWith(next);
      else if (animate) next.classList.add("is-new");
      el = next;
    }
    const want: Element | null = prev ? prev.nextElementSibling : root.firstElementChild;
    if (want !== el) root.insertBefore(el, want);
    prev = el;
  }
  old.forEach((el) => el.remove());
}

function setHtml(el: Element, html: string): void {
  if (drawn.get(el) === html) return;
  drawn.set(el, html);
  el.innerHTML = html;
}

/* ---------- The app ---------- */

export function mountTeam(): void {
  knowledge();
  const root = byId("teamStage");
  root.innerHTML = SHELL;
  const win = find(root, ".tw");
  const side = find(root, '[data-part="side"]');
  const main = find(root, '[data-part="main"]');
  const head = find(root, '[data-part="head"]');
  const feed = find(root, '[data-part="feed"]');
  const compose = find(root, '[data-part="compose"]');
  const pop = find(root, '[data-part="pop"]');
  const hints = find(root, '[data-part="hints"]');
  const field = find<HTMLInputElement>(root, '[data-part="field"]');
  const askButton = find<HTMLButtonElement>(root, '[data-act="ask-toggle"]');
  const phone = find(root, '[data-part="phone"]');
  const replay = byId<HTMLButtonElement>("teamReplay");
  const caption = byId("teamCaption");

  let model = seed();
  let worldTimers: number[] = [];
  let storyTimers: number[] = [];
  let driving = false;
  let visible = false;
  let waiting = false;
  let asking = false;
  let menu: { start: number; options: typeof MENU; active: number } | undefined;
  let lastPane = "";
  let frame = 0;
  const doneHooks = new Map<string, () => void>();

  const later = (ms: number, run: () => void, story = false): void => {
    if (reducedMotion && story) {
      run();
      return;
    }
    const id = window.setTimeout(run, reducedMotion ? 0 : ms);
    (story ? storyTimers : worldTimers).push(id);
  };
  const clear = (timers: number[]): void =>
    timers.splice(0).forEach((id) => window.clearTimeout(id));
  const update = (): void => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  const id = (prefix: string): string => `${prefix}${(model.seq += 1)}`;
  const time = (): string => {
    model.minute = Math.min(59, model.minute + (model.seq % 2));
    return `2:${model.minute} PM`;
  };

  /* --- Runs --- */

  function startRun(owner: Who, plan: Plan, taskId: string | undefined, scripted: boolean): Run {
    const run: Run = {
      id: id("r"),
      owner,
      plan,
      task: taskId,
      scripted,
      state: "working",
      steps: [],
      stepAt: 0,
      answerAt: 0,
      started: performance.now(),
      took: "",
      asking: false,
    };
    model.runs.set(run.id, run);
    let at = 700;
    for (const step of plan.steps) {
      later(at, () => addStep(run, step));
      at += 950 + step.length * 9;
    }
    later(at, () => (plan.ask ? needs(run) : finish(run, plan.answer)));
    return run;
  }

  function addStep(run: Run, step: string): void {
    if (run.state !== "working") return;
    run.steps.push(step);
    run.stepAt = performance.now();
    update();
  }

  function needs(run: Run): void {
    if (run.state !== "working") return;
    run.state = "needs";
    run.asking = true;
    if (run.owner === ME) showPhone(run);
    update();
    if (run.scripted && !driving)
      later(
        2600,
        () => {
          if (driving || run.state !== "needs") return;
          phone.classList.add("is-tapped");
          later(650, () => answer(run, "allow"), true);
        },
        true,
      );
  }

  function answer(run: Run, choice: "allow" | "deny"): void {
    if (run.state !== "needs") return;
    run.asking = false;
    hidePhone(run);
    if (choice === "deny") {
      run.state = "working";
      later(500, () => finish(run, run.plan.denied ?? "Okay, I stopped there.", true));
      update();
      return;
    }
    run.plan.allowed?.();
    run.state = "working";
    let at = 500;
    for (const step of run.plan.after ?? []) {
      later(at, () => addStep(run, step));
      at += 1000;
    }
    later(at, () => finish(run, run.plan.answer));
    update();
  }

  function finish(run: Run, text: string, denied = false): void {
    if (run.state === "stopped" || run.state === "done") return;
    run.state = "done";
    run.answer = denied
      ? text
      : text +
        (run.plan.source ? `<span class="tsource">${icon("t-doc")}${run.plan.source}</span>` : "");
    run.answerAt = performance.now();
    const seconds = Math.max(8, Math.round((performance.now() - run.started) / 1000) * 3);
    run.took = `${run.steps.length} step${run.steps.length === 1 ? "" : "s"} · ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`}`;
    const task = run.task ? model.tasks.get(run.task) : undefined;
    if (task) task.read = isOpen({ k: "task", id: task.id });
    update();
    const hook = doneHooks.get(run.id);
    if (hook) {
      doneHooks.delete(run.id);
      hook();
    }
  }

  function stop(run: Run): void {
    if (run.state === "done" || run.state === "stopped") return;
    hidePhone(run);
    run.state = "stopped";
    run.asking = false;
    run.took = "Stopped by Leo";
    update();
  }

  /* --- Phone --- */

  let phoneRun: string | undefined;
  function showPhone(run: Run): void {
    if (!run.plan.ask) return;
    phoneRun = run.id;
    phone.classList.remove("is-tapped");
    phone.innerHTML = `<div class="tphone__app"><span class="orb"></span>Opensteer<time>now</time></div><b>Needs you${run.task ? ` · ${esc(model.tasks.get(run.task)?.title ?? "")}` : ""}</b><p>${run.plan.ask.phone}</p><div class="tphone__btns"><button type="button" data-act="deny" data-run="${run.id}">Don't Allow</button><button type="button" class="tphone__allow" data-act="allow" data-run="${run.id}">Allow</button></div>`;
    phone.classList.add("is-on");
  }
  function hidePhone(run: Run): void {
    if (phoneRun !== run.id) return;
    phoneRun = undefined;
    phone.classList.remove("is-on");
  }

  /* --- Sending --- */

  function contextOf(where: Where): Msg[] {
    const conv = model.convs.get(where.conv);
    const ids = where.root
      ? [where.root, ...(model.msgs.get(where.root)?.replies ?? [])]
      : (conv?.top ?? []);
    return ids.map((key) => model.msgs.get(key)).filter((msg): msg is Msg => Boolean(msg));
  }

  function placeName(where: Where): string {
    const conv = model.convs.get(where.conv);
    if (!conv) return "this thread";
    if (conv.kind === "dm") return `your DM with ${conv.name.split(" ")[0]}`;
    return where.root ? "this thread" : `#${conv.name}`;
  }

  function post(where: Where, msg: Msg): void {
    model.msgs.set(msg.id, msg);
    const conv = model.convs.get(where.conv);
    if (!conv) return;
    if (where.root) model.msgs.get(where.root)?.replies.push(msg.id);
    else conv.top.push(msg.id);
    if (conv.typing === msg.who && !msg.agent) conv.typing = undefined;
    const pane = model.pane;
    const viewing =
      (pane.k === "conv" && pane.id === conv.id) || (pane.k === "thread" && pane.conv === conv.id);
    if (!viewing) conv.unread += 1;
    update();
  }

  /** One send path for the visitor, the story and teammates. */
  function send(who: Who, text: string, where: Where, scripted = false): void {
    const conv = model.convs.get(where.conv);
    if (!conv || !text.trim()) return;
    let parts = parse(text.trim(), who);
    if (who === ME && asking && !parts.some((part) => part.t === "agent" && part.who === ME))
      parts = [{ t: "agent", who: ME }, { t: "text", v: " " }, ...parts];
    const wakes = parts.some((part) => part.t === "agent" && part.who === who);
    const blocked = wakes && conv.peopleOnly;
    const msg: Msg = {
      id: id("m"),
      who,
      agent: false,
      time: time(),
      body: richText(parts, who, Boolean(blocked)),
      replies: [],
    };
    const strangers = parts.filter((part) => part.t === "agent" && part.who !== who);
    if (blocked) msg.note = `Agents can't be woken in #${conv.name}. It's people only.`;
    else if (strangers[0]?.t === "agent")
      msg.note = `Only ${PEOPLE[strangers[0].who].first} can ask ${PEOPLE[strangers[0].who].first}'s agent.`;
    post(where, msg);

    if (wakes && !blocked) {
      const thread = conv.kind === "dm" ? undefined : (where.root ?? msg.id);
      const at = { conv: conv.id, root: thread };
      const ask = plain(parts) || "help";
      const context = contextOf(where).filter((m) => m.id !== msg.id);
      const plan = planFor(ask, model, context, placeName(where));
      let taskId: string | undefined;
      if (who === ME) {
        taskId = id("t");
        model.tasks.set(taskId, {
          id: taskId,
          title: plan.title,
          entries: [
            {
              kind: "you",
              text: ask,
              where: conv.kind === "dm" ? `your DM with ${conv.name}` : `#${conv.name}`,
            },
          ],
          origin: thread ? { conv: conv.id, root: thread } : undefined,
          read: true,
          created: performance.now(),
        });
      }
      const run = startRun(who, plan, taskId, scripted);
      if (taskId) model.tasks.get(taskId)?.entries.push({ kind: "run", run: run.id });
      later(scripted ? 450 : 300, () => {
        post(at, {
          id: id("m"),
          who,
          agent: true,
          time: time(),
          body: "",
          run: run.id,
          replies: [],
        });
        if (who === ME && thread && !where.root && !scripted)
          open({ k: "thread", conv: conv.id, root: thread });
      });
      return;
    }
    const people = parts.filter(
      (part): part is { t: "person"; who: Who } => part.t === "person" && part.who !== who,
    );
    const target = people[0]?.who ?? (conv.kind === "dm" && who === ME ? conv.with : undefined);
    if (target && target !== ME && !scripted) reply(target, where);
  }

  const REPLIES: Record<Who, readonly string[]> = {
    leo: [],
    maya: ["On it 👍", "Thanks! I'll take a look after lunch.", "Good call. Let's do that."],
    priya: ["Thanks, looking now.", "Perfect, that unblocks me.", "Love it. Ship it."],
  };
  function reply(who: Who, where: Where): void {
    if (who === ME) return;
    const conv = model.convs.get(where.conv);
    if (!conv) return;
    later(900, () => {
      conv.typing = who;
      update();
    });
    later(2600, () => {
      const lines = REPLIES[who];
      const body = lines[model.seq % lines.length] ?? "👍";
      post(where, { id: id("m"), who, agent: false, time: time(), body: esc(body), replies: [] });
    });
  }

  /** A task from Home or a follow-up can name a channel; the agent reads it only if agents may. */
  function planFromText(ask: string): Plan {
    const named = [...model.convs.values()].find(
      (conv) => conv.kind === "channel" && new RegExp(`#?\\b${conv.name}\\b`, "i").test(ask),
    );
    if (named?.peopleOnly)
      return {
        title: `Read #${named.name}`,
        steps: [`Asked Acme for #${named.name}`],
        answer: `I can't read #${named.name}. It's people only, so Acme won't let agents read or search it.`,
      };
    if (!named) return planFor(ask, model, [], "that");
    const context = named.top.flatMap((key) => {
      const msg = model.msgs.get(key);
      return msg
        ? [msg, ...msg.replies.map((r) => model.msgs.get(r)).filter((m): m is Msg => Boolean(m))]
        : [];
    });
    return planFor(ask, model, context, `#${named.name}`);
  }

  function newTask(text: string): void {
    const ask = text.trim();
    if (!ask) return;
    const plan = planFromText(ask);
    const taskId = id("t");
    model.tasks.set(taskId, {
      id: taskId,
      title: plan.title,
      entries: [{ kind: "you", text: ask }],
      read: true,
      created: performance.now(),
    });
    const run = startRun(ME, plan, taskId, false);
    model.tasks.get(taskId)?.entries.push({ kind: "run", run: run.id });
    open({ k: "task", id: taskId });
  }

  function steer(taskId: string, text: string): void {
    const task = model.tasks.get(taskId);
    if (!task || !text.trim()) return;
    task.entries.push({ kind: "you", text: text.trim() });
    const run = startRun(ME, planFromText(text), taskId, false);
    task.entries.push({ kind: "run", run: run.id });
    update();
  }

  /* --- Seeded tasks: what's already on Leo's Mac --- */

  function seedTasks(): void {
    const seedTask = (title: string, you: string, plan: Plan, read: boolean): Run => {
      const taskId = id("t");
      model.tasks.set(taskId, {
        id: taskId,
        title,
        entries: [{ kind: "you", text: you }],
        read,
        created: performance.now() - 1e6,
      });
      const run = startRun(ME, plan, taskId, false);
      model.tasks.get(taskId)?.entries.push({ kind: "run", run: run.id });
      return run;
    };
    const invoices = seedTask(
      "Approve Q4 vendor invoices",
      "Pay the Q4 vendor invoices in Bill.com once they match the POs",
      {
        title: "Approve Q4 vendor invoices",
        steps: [],
        ask: {
          card: "Pay <b>$12,400</b> to 3 vendors on Friday?",
          phone: "Pay $12,400 to Halcyon, Northbeam and Arcwell on Friday?",
        },
        after: ["Scheduled 3 payments in Bill.com"],
        answer:
          "Scheduled $12,400 across Halcyon, Northbeam and Arcwell for Friday. Receipts will land in Finance › Q4.",
        denied: "Held all three. Nothing is scheduled.",
      },
      true,
    );
    invoices.steps.push("Opened Bill.com", "Matched 3 invoices to their POs");
    invoices.state = "needs";
    invoices.asking = true;
    clear(worldTimers);
    const board = seedTask(
      "Summarize the board call",
      "Summarize the board call recording and file the notes",
      { title: "", steps: [], answer: "" },
      false,
    );
    board.steps.push("Transcribed the recording", "Filed notes in Docs › Board › November");
    board.state = "done";
    board.answer =
      "Three decisions: ship 2.4 on Thursday, hire two support leads, and revisit pricing in Q1. Notes are in Docs › Board › November.";
    board.took = "2 steps · 3m 40s";
    seedTask(
      "Fix the flaky sync test",
      "The sync test keeps failing on CI. Find out why and fix it",
      {
        title: "",
        steps: [
          "Ran the sync test 40 times",
          "Found a race in the retry timer",
          "Wrote a regression test",
          "Opened PR #612",
        ],
        answer:
          "The retry timer could fire after the socket closed. PR #612 fixes it and adds a regression test; CI is green.",
      },
      true,
    );
  }

  /* --- Navigation --- */

  const paneKey = (pane: Pane): string =>
    pane.k === "conv"
      ? `conv:${pane.id}`
      : pane.k === "thread"
        ? `thread:${pane.root}`
        : pane.k === "task"
          ? `task:${pane.id}`
          : pane.k;
  const isOpen = (pane: Pane): boolean => paneKey(pane) === paneKey(model.pane);

  function open(pane: Pane): void {
    model.pane = pane;
    model.mobile = "main";
    if (pane.k === "conv") {
      const conv = model.convs.get(pane.id);
      if (conv) conv.unread = 0;
    }
    if (pane.k === "thread") {
      const conv = model.convs.get(pane.conv);
      if (conv) conv.unread = 0;
    }
    if (pane.k === "task") {
      const task = model.tasks.get(pane.id);
      if (task) task.read = true;
    }
    closeMenu();
    update();
  }

  /* --- Rendering --- */

  function runState(run: Run): string {
    if (run.state === "needs")
      return run.owner === ME ? "Needs you" : `Needs ${PEOPLE[run.owner].first}`;
    return run.state === "working" ? "Working" : run.state === "done" ? "Done" : "Stopped";
  }

  const spin = (): string => `<span class="tcard__spin"></span>`;
  const fresh = (at: number): string => (performance.now() - at < 400 ? " is-fresh" : "");

  function steps(run: Run): string {
    return run.steps
      .map(
        (step, at) =>
          `<li class="${at === run.steps.length - 1 ? fresh(run.stepAt).trim() : ""}">${icon("i-check")}<span>${esc(step)}</span></li>`,
      )
      .join("");
  }

  function askBox(run: Run): string {
    if (run.state !== "needs" || !run.plan.ask) return "";
    const buttons =
      run.owner === ME
        ? `<span class="tcard__btns"><button type="button" data-act="deny" data-run="${run.id}">Don't Allow</button><button type="button" class="is-allow" data-act="allow" data-run="${run.id}">Allow</button></span>`
        : `<span class="tcard__wait">Waiting on ${PEOPLE[run.owner].first}</span>`;
    return `<div class="tcard__ask"><span>${run.plan.ask.card}</span>${buttons}</div>`;
  }

  function card(run: Run): string {
    const mine = run.owner === ME;
    const meta =
      run.state === "done" || run.state === "stopped"
        ? run.took
        : run.state === "needs"
          ? mine
            ? "sent to your phone"
            : ""
          : `on ${PEOPLE[run.owner].first}'s MacBook`;
    const actions = mine
      ? `${run.state === "working" ? `<button type="button" class="tcard__stop" data-act="stop" data-run="${run.id}" aria-label="Stop">${icon("i-stop")}</button>` : ""}${run.task ? `<button type="button" class="tcard__open" data-act="task" data-id="${run.task}">Open task</button>` : ""}`
      : "";
    return `<div class="tcard" data-state="${run.state}"><div class="tcard__top">${run.state === "working" ? spin() : `<span class="tcard__dot"></span>`}<b>${runState(run)}</b><span class="tcard__meta">${meta}</span><span class="tcard__acts">${actions}</span></div>${run.state === "working" || run.state === "needs" ? `<ol class="tcard__steps">${steps(run)}</ol>` : ""}${askBox(run)}</div>`;
  }

  function message(msg: Msg, summary: boolean): string {
    const person = PEOPLE[msg.who];
    const run = msg.run ? model.runs.get(msg.run) : undefined;
    const name = msg.agent
      ? msg.who === ME
        ? "Your agent"
        : `${person.first}'s agent`
      : person.name;
    const badge = msg.agent ? `<span class="tm__badge">Agent</span>` : "";
    let body = `<div class="tm__text">${msg.body}</div>`;
    if (run) {
      body = card(run);
      if (run.answer)
        body += `<div class="tm__text tm__answer${fresh(run.answerAt)}">${run.answer}</div>`;
    }
    const note = msg.note ? `<div class="tm__note">${icon("i-lock")}${esc(msg.note)}</div>` : "";
    let thread = "";
    if (summary && msg.replies.length) {
      const replies = msg.replies
        .map((key) => model.msgs.get(key))
        .filter((m): m is Msg => Boolean(m));
      const faces = [...new Set(replies.map((m) => m.who))].map((who) => mark(who)).join("");
      const live = replies
        .map((m) => (m.run ? model.runs.get(m.run) : undefined))
        .find((r) => r && (r.state === "working" || r.state === "needs"));
      const status = live
        ? ` · <em>${live.owner === ME ? "Your agent" : `${PEOPLE[live.owner].first}'s agent`} is ${live.state === "needs" ? "waiting on you" : "working"}</em>`
        : "";
      thread = `<button type="button" class="tm__replies" data-act="thread" data-id="${msg.id}"><span class="tm__faces">${faces}</span>${replies.length} ${replies.length === 1 ? "reply" : "replies"}${status}</button>`;
    }
    return `<div class="tm${msg.agent ? " tm--agent" : ""}">${mark(msg.who, msg.agent)}<div class="tm__body"><div class="tm__who"><b>${name}</b>${badge}<time>${msg.time}</time></div>${body}${note}${thread}</div></div>`;
  }

  function taskRow(task: Task, inSide: boolean): string {
    const run = lastRun(task);
    const state = run?.state ?? "done";
    const glyph =
      state === "needs"
        ? `<span class="trow__need">!</span>`
        : state === "working"
          ? spin()
          : !task.read
            ? `<span class="trow__dot"></span>`
            : `<span class="trow__done">${icon("i-check")}</span>`;
    const sub =
      state === "needs" && run?.plan.ask
        ? `<small>${run.plan.ask.card.replace(/<[^>]+>/g, "")}</small>`
        : "";
    const on = isOpen({ k: "task", id: task.id }) ? " is-on" : "";
    return `<button type="button" class="${inSide ? "tw-row tw-row--task" : "trow"}${on}${!task.read && state === "done" ? " is-unread" : ""}" data-act="task" data-id="${task.id}"><span class="tw-row__text">${esc(task.title)}${sub}</span>${glyph}</button>`;
  }

  const lastRun = (task: Task): Run | undefined => {
    const entry = [...task.entries]
      .reverse()
      .find((e): e is { kind: "run"; run: string } => e.kind === "run");
    return entry ? model.runs.get(entry.run) : undefined;
  };
  const isLive = (task: Task): boolean => {
    const state = lastRun(task)?.state;
    return state === "needs" || state === "working" || !task.read;
  };
  const orderedTasks = (): Task[] =>
    [...model.tasks.values()].sort((a, b) => {
      const need = (t: Task): number => (lastRun(t)?.state === "needs" ? 1 : 0);
      return need(b) - need(a) || b.created - a.created;
    });

  function sideHtml(): string {
    const tasks = orderedTasks();
    const needCount = tasks.filter((t) => lastRun(t)?.state === "needs").length;
    const unreadTask = tasks.some((t) => !t.read);
    const mentions = [...model.convs.values()].reduce((sum, conv) => sum + conv.unread, 0);
    const tasksBadge = needCount
      ? `<i class="tw-need">!</i>`
      : unreadTask
        ? `<i class="tw-new"></i>`
        : "";
    const teamBadge = mentions ? `<i class="tw-count">${mentions}</i>` : "";
    let list = "";
    if (model.side === "tasks") {
      const live = tasks.filter(isLive);
      list = `<div class="tw-label">Tasks${needCount ? `<span class="tw-pill">! ${needCount}</span>` : ""}</div>${live.map((t) => taskRow(t, true)).join("")}<button type="button" class="tw-row tw-row--all${isOpen({ k: "all" }) ? " is-on" : ""}" data-act="all"><span class="tw-hash">≡</span>All tasks<span class="tw-meta">${tasks.length} ›</span></button>`;
    } else {
      const rows = [...model.convs.values()]
        .filter((conv) => conv.kind === "channel")
        .map((conv) => {
          const on =
            isOpen({ k: "conv", id: conv.id }) ||
            (model.pane.k === "thread" && model.pane.conv === conv.id)
              ? " is-on"
              : "";
          const glyph = conv.peopleOnly ? icon("i-lock") : "#";
          return `<button type="button" class="tw-row${on}${conv.unread ? " is-unread" : ""}" data-act="conv" data-id="${conv.id}"><span class="tw-hash">${glyph}</span>${conv.name}${conv.unread ? `<span class="tw-count">${conv.unread}</span>` : ""}</button>`;
        })
        .join("");
      const dms = [...model.convs.values()]
        .filter((conv) => conv.kind === "dm" && conv.with)
        .map((conv) => {
          const on = isOpen({ k: "conv", id: conv.id }) ? " is-on" : "";
          return `<button type="button" class="tw-row${on}${conv.unread ? " is-unread" : ""}" data-act="conv" data-id="${conv.id}">${mark(conv.with ?? "maya")}${conv.name}${conv.unread ? `<span class="tw-count">${conv.unread}</span>` : ""}</button>`;
        })
        .join("");
      list = `<div class="tw-label">Channels</div>${rows}<div class="tw-label">Direct messages</div>${dms}`;
    }
    return `<div class="tw-lights"><i></i><i></i><i></i></div>
      <div class="tw-brand"><b>Opensteer</b><span><span class="tw-icon" aria-hidden="true">${icon("i-mic")}</span><span class="tw-icon" aria-hidden="true">${icon("m-search")}</span><button type="button" class="tw-icon" data-act="home" aria-label="New task">${icon("m-plus")}</button></span></div>
      <div class="tw-switch" role="tablist"><button type="button" role="tab" aria-selected="${model.side === "tasks"}" class="tw-seg${model.side === "tasks" ? " is-on" : ""}" data-act="side" data-id="tasks">Tasks${tasksBadge}</button><button type="button" role="tab" aria-selected="${model.side === "team"}" class="tw-seg${model.side === "team" ? " is-on" : ""}" data-act="side" data-id="team"><span class="tw-team">A</span>Acme${teamBadge}</button></div>
      <div class="tw-list">${list}</div>
      <div class="tw-foot"><b>Leo's MacBook</b><span><i></i>Connected · Acme</span></div>`;
  }

  const back = `<button type="button" class="tw-back" data-act="back" aria-label="Back">${icon("m-chevl")}</button>`;

  function headHtml(): string {
    const pane = model.pane;
    if (pane.k === "conv") {
      const conv = model.convs.get(pane.id);
      if (!conv) return back;
      if (conv.kind === "dm") return `${back}${mark(conv.with ?? "maya")}<b>${conv.name}</b>`;
      const lock = conv.peopleOnly
        ? `<span class="tw-tag">${icon("i-lock")}People only</span>`
        : "";
      return `${back}<b># ${conv.name}</b><span>${conv.topic}</span>${lock}<span class="tw-people">${mark("maya")}${mark("leo")}${mark("priya")}<em>${conv.peopleOnly ? 4 : 14}</em></span>`;
    }
    if (pane.k === "thread") {
      const conv = model.convs.get(pane.conv);
      return `${back}<b>Thread</b><button type="button" class="tw-crumb" data-act="conv" data-id="${pane.conv}"># ${conv?.name ?? ""}</button><button type="button" class="tw-close" data-act="conv" data-id="${pane.conv}" aria-label="Close thread">${icon("i-xmark")}</button>`;
    }
    if (pane.k === "task") {
      const task = model.tasks.get(pane.id);
      if (!task) return back;
      const origin = task.origin
        ? `<button type="button" class="tw-crumb tw-crumb--chip" data-act="thread" data-id="${task.origin.root}" data-conv="${task.origin.conv}">${icon("m-chevl")}<span class="tw-team">A</span>#${model.convs.get(task.origin.conv)?.name ?? ""}</button>`
        : "";
      return `${back}<b>${esc(task.title)}</b>${origin}`;
    }
    if (pane.k === "all") return `${back}<b>All tasks</b>`;
    return `${back}<b>New task</b>`;
  }

  function feedItems(): Array<readonly [string, string]> {
    const pane = model.pane;
    const items: Array<readonly [string, string]> = [];
    if (pane.k === "conv") {
      const conv = model.convs.get(pane.id);
      if (!conv) return items;
      if (conv.peopleOnly)
        items.push([
          "banner",
          `<div class="tw-banner">${icon("i-lock")}<span><b>#${conv.name} is people only.</b> Agents can't be woken here, read it or search it.</span></div>`,
        ]);
      for (const key of conv.top) {
        const msg = model.msgs.get(key);
        if (msg) items.push([key, message(msg, true)]);
      }
      if (conv.typing) items.push([`typing-${conv.typing}`, typing(conv.typing)]);
    } else if (pane.k === "thread") {
      const rootMsg = model.msgs.get(pane.root);
      const conv = model.convs.get(pane.conv);
      if (!rootMsg) return items;
      items.push([rootMsg.id, message(rootMsg, false)]);
      if (rootMsg.replies.length)
        items.push([
          "divider",
          `<div class="tw-divider"><span>${rootMsg.replies.length} ${rootMsg.replies.length === 1 ? "reply" : "replies"}</span></div>`,
        ]);
      for (const key of rootMsg.replies) {
        const msg = model.msgs.get(key);
        if (msg) items.push([key, message(msg, false)]);
      }
      if (conv?.typing) items.push([`typing-${conv.typing}`, typing(conv.typing)]);
    } else if (pane.k === "task") {
      const task = model.tasks.get(pane.id);
      if (!task) return items;
      task.entries.forEach((entry, at) => {
        if (entry.kind === "you")
          items.push([
            `e${at}`,
            `<div class="tk-you">${entry.where ? `<span>Leo in ${esc(entry.where)}</span>` : `<span>You</span>`}<p>${esc(entry.text)}</p></div>`,
          ]);
        else {
          const run = model.runs.get(entry.run);
          if (run) items.push([`e${at}`, taskRun(run)]);
        }
      });
    } else if (pane.k === "all") {
      for (const task of orderedTasks()) items.push([task.id, taskRow(task, false)]);
    } else {
      items.push([
        "home",
        `<div class="tw-home"><h3>What should your agent do?</h3><p>It works on Leo's MacBook, with Leo's apps and accounts.</p></div>`,
      ]);
    }
    return items;
  }

  const typing = (who: Who): string =>
    `<div class="tm tm--typing">${mark(who)}<span>${PEOPLE[who].first} is typing<i></i><i></i><i></i></span></div>`;

  function taskRun(run: Run): string {
    const list = steps(run);
    const working =
      run.state === "working"
        ? `<li class="is-working">${spin()}<span>Working on Leo's MacBook…</span></li>`
        : "";
    const stopped =
      run.state === "stopped"
        ? `<li class="is-stopped">${icon("i-stop")}<span>Stopped by Leo</span></li>`
        : "";
    const stopButton =
      run.state === "working"
        ? `<button type="button" class="tk-stop" data-act="stop" data-run="${run.id}">${icon("i-stop")}Stop</button>`
        : "";
    const answer = run.answer
      ? `<div class="tk-answer${fresh(run.answerAt)}">${run.answer}</div>`
      : "";
    return `<div class="tk-run"><ol class="tk-steps">${list}${working}${stopped}</ol>${askBox(run)}${answer}${stopButton}</div>`;
  }

  function hintsHtml(): string {
    if (!driving || field.value) return "";
    const pane = model.pane;
    const ideas =
      pane.k === "home"
        ? [
            "Summarize what happened in #support",
            "File a Linear issue for the double charge",
            "Book a sync with Maya and Priya",
          ]
        : pane.k === "task"
          ? ["Also log it in HubSpot", "Draft a reply to Northwind"]
          : pane.k === "conv" && model.convs.get(pane.id)?.peopleOnly
            ? []
            : [
                "@My agent summarize this thread",
                "@My agent draft a reply to Northwind",
                "@Maya's agent check this",
              ];
    return ideas
      .map(
        (idea) =>
          `<button type="button" data-act="hint" data-text="${esc(idea)}">${esc(idea.replace("@My agent ", ""))}</button>`,
      )
      .join("");
  }

  function placeholder(): string {
    const pane = model.pane;
    if (pane.k === "home") return "Ask your agent to…";
    if (pane.k === "task") return "Message your agent…";
    if (asking) return "Ask your agent…";
    if (pane.k === "thread") return "Reply…";
    if (pane.k === "conv") {
      const conv = model.convs.get(pane.id);
      return conv?.kind === "dm" ? `Message ${conv.name}` : `Message #${conv?.name ?? ""}`;
    }
    return "";
  }

  function render(): void {
    frame = 0;
    const key = paneKey(model.pane);
    const switched = key !== lastPane;
    lastPane = key;
    win.dataset.pane = model.mobile;
    main.classList.toggle("is-home", model.pane.k === "home");
    setHtml(side, sideHtml());
    setHtml(head, headHtml());
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    if (switched) feed.innerHTML = "";
    patch(feed, feedItems(), !switched);
    compose.hidden = model.pane.k === "all";
    field.placeholder = placeholder();
    const agentPane = model.pane.k === "task" || model.pane.k === "home";
    askButton.hidden = agentPane;
    askButton.setAttribute("aria-pressed", String(asking));
    setHtml(hints, hintsHtml());
    // A redrawn spinner picks up the shared phase, so replacing a row never makes it jump.
    win.querySelectorAll<HTMLElement>(".tcard__spin:not([data-phased])").forEach((el) => {
      el.style.animationDelay = `-${Math.round(performance.now() % 900)}ms`;
      el.dataset.phased = "";
    });
    if (switched || nearBottom)
      feed.scrollTo({
        top: feed.scrollHeight,
        behavior: switched || reducedMotion ? "auto" : "smooth",
      });
  }

  /* --- Mention menu --- */

  function openMenuAt(start: number, query: string): void {
    const q = query.toLowerCase();
    const options = (q ? MENU : MENU.slice(0, 3)).filter(
      (option) =>
        !q ||
        option.match.split(" ").some((word) => word.startsWith(q)) ||
        option.match.startsWith(q),
    );
    if (!options.length) {
      closeMenu();
      return;
    }
    menu = { start, options, active: 0 };
    drawMenu();
  }
  function drawMenu(): void {
    if (!menu) return;
    const current = menu;
    pop.innerHTML = current.options
      .map(
        (option, at) =>
          `<button type="button" role="option" aria-selected="${at === current.active}" class="tw-opt${at === current.active ? " is-on" : ""}" data-act="mention" data-label="${esc(option.label)}">${option.html}${option.hint ? `<span>${option.hint}</span>` : ""}</button>`,
      )
      .join("");
    pop.classList.add("is-on");
  }
  function closeMenu(): void {
    menu = undefined;
    pop.classList.remove("is-on");
  }
  function pick(label: string): void {
    const start = menu?.start ?? field.value.lastIndexOf("@");
    const caret = field.selectionStart ?? field.value.length;
    const before = field.value.slice(0, Math.max(0, start));
    const after = field.value.slice(caret);
    field.value = `${before}@${label} ${after.trimStart()}`;
    const at = before.length + label.length + 2;
    field.setSelectionRange(at, at);
    closeMenu();
    update();
  }
  function watchMention(): void {
    const caret = field.selectionStart ?? field.value.length;
    const upto = field.value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0 || (at > 0 && !/\s/.test(upto.charAt(at - 1)))) {
      closeMenu();
      return;
    }
    const query = upto.slice(at + 1);
    if (
      query.length > 14 ||
      /\s{2}|\n/.test(query) ||
      (query.includes(" ") && !/^(my|maya|priya|leo)/i.test(query))
    ) {
      closeMenu();
      return;
    }
    openMenuAt(at, query);
  }

  function submit(): void {
    const text = field.value;
    if (!text.trim()) return;
    field.value = "";
    closeMenu();
    const pane = model.pane;
    if (pane.k === "home") newTask(text);
    else if (pane.k === "task") steer(pane.id, text);
    else if (pane.k === "conv") send(ME, text, { conv: pane.id });
    else if (pane.k === "thread") send(ME, text, { conv: pane.conv, root: pane.root });
    update();
  }

  /* --- Visitor input --- */

  function takeOver(): void {
    if (driving) return;
    driving = true;
    clear(storyTimers);
    phone.classList.remove("is-tapped");
    if (document.activeElement !== field) field.value = "";
    model.convs.forEach((conv) => {
      conv.typing = undefined;
    });
    closeMenu();
    caption.textContent =
      "You're driving. Ask @My agent anything, open a channel, or switch to Tasks.";
    replay.hidden = false;
    update();
  }
  for (const type of ["pointerdown", "keydown", "focusin"] as const)
    win.addEventListener(type, (event) => {
      if (event.isTrusted) takeOver();
    });

  win.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLElement>("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    const key = target.dataset.id ?? "";
    const run = target.dataset.run ? model.runs.get(target.dataset.run) : undefined;
    if (act === "conv") open({ k: "conv", id: key });
    else if (act === "thread") {
      const msg = model.msgs.get(key);
      const conv =
        target.dataset.conv ?? [...model.convs.values()].find((c) => c.top.includes(key))?.id;
      if (msg && conv) {
        model.side = "team";
        open({ k: "thread", conv, root: key });
      }
    } else if (act === "task") open({ k: "task", id: key });
    else if (act === "all") open({ k: "all" });
    else if (act === "home") open({ k: "home" });
    else if (act === "side") {
      model.side = key === "tasks" ? "tasks" : "team";
      update();
    } else if (act === "back") {
      model.mobile = "side";
      update();
    } else if (act === "allow" && run) answer(run, "allow");
    else if (act === "deny" && run) answer(run, "deny");
    else if (act === "stop" && run) stop(run);
    else if (act === "mention") {
      pick(target.dataset.label ?? "My agent");
      field.focus();
    } else if (act === "ask-toggle") {
      asking = !asking;
      update();
      field.focus();
    } else if (act === "send") submit();
    else if (act === "hint") {
      field.value = `${target.dataset.text ?? ""}`;
      field.focus();
      submit();
    }
  });

  field.addEventListener("input", () => {
    watchMention();
    update();
  });
  field.addEventListener("click", watchMention);
  field.addEventListener("keydown", (event) => {
    if (menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        menu.active = (menu.active + step + menu.options.length) % menu.options.length;
        drawMenu();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(menu.options[menu.active]?.label ?? "My agent");
        return;
      }
      if (event.key === "Escape") {
        closeMenu();
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  field.addEventListener("blur", () => window.setTimeout(closeMenu, 150));

  /* --- The story --- */

  const LEO_ASK = "check Stripe and refund the duplicate if it's within policy";

  function typeInto(text: string, done: () => void): void {
    if (reducedMotion) {
      field.value += text;
      done();
      return;
    }
    let shown = 0;
    const base = field.value;
    const tick = (): void => {
      if (driving) return;
      shown += 1;
      field.value = base + text.slice(0, shown);
      if (shown < text.length) later(24, tick, true);
      else done();
    };
    later(24, tick, true);
  }

  function story(): void {
    const support = model.convs.get("support");
    const root = support?.top[1];
    if (!support || !root) return;
    model.side = "team";
    open({ k: "thread", conv: "support", root });
    later(
      1000,
      () => {
        field.value = "@";
        openMenuAt(0, "");
      },
      true,
    );
    later(
      2100,
      () => {
        closeMenu();
        field.value = "@My agent ";
        typeInto(LEO_ASK, () =>
          later(
            500,
            () => {
              const text = field.value;
              field.value = "";
              send(ME, text, { conv: "support", root }, true);
              const leoRun = [...model.runs.values()].find((r) => r.scripted && r.owner === ME);
              if (leoRun) doneHooks.set(leoRun.id, priyaAsks);
            },
            true,
          ),
        );
      },
      true,
    );
    function priyaAsks(): void {
      if (driving) return;
      later(
        2200,
        () => {
          const room = model.convs.get("support");
          if (room) room.typing = "priya";
          update();
        },
        true,
      );
      later(
        3600,
        () => {
          send(
            "priya",
            "@My agent log this on Northwind's account in HubSpot",
            { conv: "support", root },
            true,
          );
          const priyaRun = [...model.runs.values()].find((r) => r.scripted && r.owner === "priya");
          if (priyaRun)
            doneHooks.set(priyaRun.id, () =>
              later(
                8000,
                () => {
                  if (driving || reducedMotion) return;
                  if (visible) restartAll();
                  else waiting = true;
                },
                true,
              ),
            );
        },
        true,
      );
    }
  }

  function restartAll(): void {
    clear(storyTimers);
    clear(worldTimers);
    doneHooks.clear();
    model = seed();
    seedTasks();
    phoneRun = undefined;
    phone.classList.remove("is-on", "is-tapped");
    asking = false;
    field.value = "";
    lastPane = "";
    closeMenu();
    story();
    update();
  }

  replay.addEventListener("click", () => {
    driving = false;
    replay.hidden = true;
    caption.textContent = "Click anywhere in the window to take over.";
    restartAll();
  });

  seedTasks();
  render();
  if (reducedMotion) {
    story();
    return;
  }
  let started = false;
  new IntersectionObserver(
    ([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (!visible || driving) return;
      if (!started) {
        started = true;
        story();
      } else if (waiting) {
        waiting = false;
        restartAll();
      }
    },
    { threshold: 0.35 },
  ).observe(root);
}
