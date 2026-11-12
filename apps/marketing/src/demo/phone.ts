import { find, icon, restart } from "../dom.js";
import { AGENTS, type AgentId, type Engine, ORDER } from "./agents.js";
import { HOME } from "./home.js";

export type Status = "idle" | "working" | "needs" | "done" | "stopped";

/** What a thread opens with: the person's dictated message, or what a trigger sent. */
export interface Opener {
  readonly text: string;
  /** The trigger's name when no person sent it. */
  readonly from?: string;
}

export interface Step {
  readonly icon: "globe" | "pencil" | "terminal";
  readonly text: string;
  /** A path or command, in the app's code face. */
  readonly detail?: string;
}

export type View = "home" | "list" | "new" | "thread";

export interface TaskView {
  readonly id: AgentId;
  readonly title: string;
  readonly status: Status;
  /** Null until the person has sent it. */
  readonly opener: Opener | null;
  readonly steps: readonly Step[];
  /** The agent's closing message. */
  readonly message: string | null;
  /** How long the run took, once it is over. */
  readonly worked: string;
}

export interface RequestView {
  readonly title: string;
  readonly body: string;
}

export interface Push {
  readonly title: string;
  readonly text: string;
}

/** What a task row says after its title. A working row shows a spinner instead. */
const ROW_STATE: Record<Status, string> = {
  idle: "",
  working: "",
  needs: "Needs you",
  done: "now",
  stopped: "now",
};
const isActive = (status: Status): boolean => status === "working" || status === "needs";

const STATUS_BAR = `<div class="ip-status"><b>9:41</b><span><svg viewBox="0 0 18 12"><path d="M1 8.5h2.5V11H1zM5.5 6H8v5H5.5zM10 3.5h2.5V11H10zM14.5 1H17v10h-2.5z" fill="currentColor"/></svg><svg viewBox="0 0 16 16"><use href="#m-wifi"/></svg><svg viewBox="0 0 25 12"><use href="#m-batt"/></svg></span></div>`;
const glyph = (d: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const STEP_ICON: Record<Step["icon"], string> = {
  globe: glyph(
    "M2 8a6 6 0 1 0 12 0A6 6 0 0 0 2 8ZM2 8h12M8 2c2 2 2.5 3.8 2.5 6S10 12 8 14M8 2C6 4 5.5 5.8 5.5 8S6 12 8 14",
  ),
  pencil: glyph("M10.5 3 13 5.5 5.5 13H3v-2.5ZM9 4.5 11.5 7"),
  terminal: glyph("M2.5 3.5h11v9h-11ZM5 6.5 7 8 5 9.5M8.5 10h2.5"),
};
const BOLT = glyph("M8.8 2 4 9h3.6l-.6 5L12 7H8.3Z");
const XMARK = glyph("M4 4l8 8M12 4l-8 8");
const CHECK = glyph("M3.5 8.5 6.5 11.5 12.5 4.5");

/** The app's composer. Expanded, it names the engine's model. Dictating swaps its controls for the waveform, the time, keep and send. */
const composer = (placeholder: string, expanded = false): string =>
  `<div class="ip-composer"${expanded ? " data-expanded" : ""}><div class="ip-composer__row"><span class="ip-btn">${icon("m-plus")}</span><span class="ip-text" data-placeholder="${placeholder}"></span><span class="ip-model"><i></i><b></b>${glyph("M4 6.5 8 10.5l4-4")}</span><span class="ip-btn ip-mic">${icon("i-mic")}</span><span class="ip-btn ip-btn--send">${icon("i-up")}</span></div><div class="ip-dict"><span class="ip-btn">${XMARK}</span><span class="ip-wave">${"<i></i>".repeat(40)}</span><span class="ip-elapsed"><i></i><b>0:00</b></span><span class="ip-keep">${CHECK}</span><span class="ip-btn ip-btn--send">${icon("i-up")}</span></div></div>`;

const nav = (glyph: string, label: string): string => `<div class="ip-nav">${glyph}${label}</div>`;
const finished = (glyph: string, title: string, when: string): string =>
  `<div class="ip-row ip-row--past"><span class="tmark">${icon(glyph)}</span><span class="ip-row__title">${title}</span><span class="ip-row__state">${when}</span></div>`;

/** The Opensteer app at an iPhone's 393x852 points: its task list, a new task, and one thread. */
export const PHONE = `<div class="iphone">
  <div class="ip-screen">
    <div class="ip-island"></div>
    ${STATUS_BAR}
    ${HOME}
    <div class="ip-list">
      <div class="ip-dhead"><b>Opensteer</b>${icon("m-search")}</div>
      <div class="ip-nav" data-part="new">${icon("m-compose")}New task</div>
      ${nav(icon("i-mic"), "Voice")}
      ${nav(icon("i-clock"), "Automations")}
      ${nav(`<span class="ip-team">A</span>`, `Acme<span class="ip-badge">3</span>`)}
      <div class="ip-sep"></div>
      <div class="ip-group">Working <span data-part="count"></span></div>
      <div data-part="working"></div>
      <div class="ip-group">Ready</div>
      <div data-part="ready"></div>
      ${finished("t-doc", "October invoices paid", "Mon")}
      ${finished("t-chart", "Board deck numbers", "Fri")}
    </div>
    <div class="ip-new">
      <div class="ip-bar"><span class="ip-back">${icon("m-chevl")}</span></div>
      <h3>What should your agent do?</h3>
      ${composer("Ask your agent to…", true)}
    </div>
    <div class="ip-thread">
      <div class="ip-bar"><button class="ip-back" type="button" aria-label="Back to your tasks">${icon("m-chevl")}</button><div class="ip-cap" data-part="capsule"><span class="tmark" data-part="mark"></span><b data-part="title"></b><i class="pip"></i></div></div>
      <div class="ip-live" aria-hidden="true"><div class="mirror"></div></div>
      <div class="ip-feed" data-part="feed"></div>
      <div class="ip-req"><b></b><p></p><div class="ip-req__btns"><button type="button" data-answer="deny">Don’t Allow</button><button type="button" data-answer="allow">Allow</button></div></div>
      ${composer("Message")}
    </div>
    <button class="ip-push" type="button">${icon("d-os")}<div><b></b><span></span></div><time>now</time></button>
    <span class="ip-finger"></span>
    <div class="ip-home"></div>
  </div>
</div>`;

export interface PhoneEvents {
  pick(id: AgentId): void;
  back(): void;
  push(): void;
  answer(answer: "allow" | "deny"): void;
}

export interface Phone {
  /** Where a copy of the Mac's desktop goes: the live page of the thread's run. */
  readonly mirror: HTMLElement;
  readonly push: HTMLElement;
  readonly allow: HTMLElement;
  readonly back: HTMLElement;
  readonly newTask: HTMLElement;
  readonly mic: HTMLElement;
  readonly send: HTMLElement;
  setView(view: View): void;
  /** Names the engine in the composers, as the app does once a composer is expanded. */
  showEngine(engine: Engine): void;
  /** Opens the thread's composer up, as a touch on it does. */
  expand(on: boolean): void;
  /** The new task's composer while the person dictates: the words so far and the seconds since the mic. */
  dictate(words: string | null, seconds?: number): void;
  showRows(tasks: readonly TaskView[]): void;
  showThread(task: TaskView, request: RequestView | null): void;
  showPush(push: Push | null): void;
  /** A touch, as a screen recording shows one. */
  tap(target: Element): void;
}

function feedOf(task: TaskView, fresh: "step" | "message" | null): string {
  const { opener, steps, message } = task;
  if (!opener) return "";
  const from = opener.from ? `<div class="ip-from">${BOLT}${opener.from}</div>` : "";
  const bubble = `${from}<div class="ip-said${opener.from ? " ip-said--input" : ""}">${opener.text}</div>`;
  if (task.status === "idle") return bubble;
  const over = !isActive(task.status);
  const head = over
    ? `<div class="ip-work">${task.worked}${icon("m-chevr")}</div>`
    : `<div class="ip-work"><i class="ip-dot"></i>Working</div>`;
  const rows = over
    ? ""
    : steps
        .map(
          (step, index) =>
            `<div class="ip-step${fresh === "step" && index === steps.length - 1 ? " is-new" : ""}">${STEP_ICON[step.icon]}<span>${step.text}${step.detail ? `<code>${step.detail}</code>` : ""}</span>${icon("m-chevr")}</div>`,
        )
        .join("");
  const reply =
    message === null
      ? ""
      : `<p class="ip-reply${fresh === "message" ? " is-new" : ""}">${message}</p>`;
  return `${bubble}${head}${rows}${reply}`;
}

export function createPhone(el: HTMLElement, events: PhoneEvents): Phone {
  const screen = find(el, ".ip-screen");
  const part = (name: string): HTMLElement => find(el, `[data-part="${name}"]`);
  const screens: Record<View, HTMLElement> = {
    home: find(el, ".ip-spring"),
    list: find(el, ".ip-list"),
    new: find(el, ".ip-new"),
    thread: find(el, ".ip-thread"),
  };
  const draft = find(screens.new, ".ip-composer");
  const back = find<HTMLButtonElement>(el, ".ip-thread .ip-back");
  const push = find<HTMLButtonElement>(el, ".ip-push");
  const request = find(el, ".ip-req");
  const feed = part("feed");
  const finger = find(el, ".ip-finger");
  const rows = new Map<AgentId, HTMLButtonElement>();
  for (const id of ORDER) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ip-row";
    row.hidden = true;
    row.style.setProperty("--ac", AGENTS[id].color);
    row.innerHTML = `<span class="tmark">${icon(AGENTS[id].glyph)}</span><span class="ip-row__title"></span><span class="ip-row__state"></span><i class="ip-row__spin"></i>`;
    row.addEventListener("click", () => events.pick(id));
    part("working").appendChild(row);
    rows.set(id, row);
  }
  back.addEventListener("click", events.back);
  push.addEventListener("click", events.push);
  request.addEventListener("click", (event) => {
    const answer = (event.target as Element).closest<HTMLElement>("[data-answer]")?.dataset.answer;
    if (answer === "allow" || answer === "deny") events.answer(answer);
  });
  let shown = { id: "", opener: false, steps: 0, message: false, status: "" };
  let watched: AgentId = ORDER[0] ?? "support";
  return {
    mirror: find(el, ".mirror"),
    push,
    allow: find(el, '[data-answer="allow"]'),
    back,
    newTask: part("new"),
    mic: find(draft, ".ip-mic"),
    send: find(draft, ".ip-dict .ip-btn--send"),
    setView(view) {
      if (el.dataset.view === view) return;
      const hadFocus = el.contains(document.activeElement);
      /* Leaving the home screen is the app opening, not a screen sliding in. */
      el.toggleAttribute("data-launch", el.dataset.view === "home");
      el.dataset.view = view;
      (Object.keys(screens) as View[]).forEach((name) => {
        screens[name].inert = name !== view;
      });
      if (hadFocus) (view === "thread" ? back : rows.get(watched))?.focus({ preventScroll: true });
    },
    showEngine(engine) {
      el.querySelectorAll(".ip-model").forEach((pill) => {
        find(pill, "i").innerHTML = icon(engine.mark);
        find(pill, "b").textContent = engine.model;
      });
    },
    expand(on) {
      find(screens.thread, ".ip-composer").toggleAttribute("data-expanded", on);
    },
    dictate(words, seconds = 0) {
      draft.toggleAttribute("data-dictating", words !== null);
      find(draft, ".ip-text").textContent = words ?? "";
      find(draft, ".ip-elapsed b").textContent = `0:${String(seconds).padStart(2, "0")}`;
    },
    showRows(tasks) {
      for (const task of tasks) {
        const row = rows.get(task.id);
        if (!row) continue;
        const shelf = part(isActive(task.status) ? "working" : "ready");
        if (row.parentElement !== shelf) {
          const later = ORDER.slice(ORDER.indexOf(task.id) + 1).map((id) => rows.get(id));
          shelf.insertBefore(row, later.find((other) => other?.parentElement === shelf) ?? null);
        }
        row.hidden = task.status === "idle";
        row.dataset.state = task.status;
        find(row, ".ip-row__title").textContent = task.title;
        find(row, ".ip-row__state").textContent = ROW_STATE[task.status];
      }
      part("count").textContent = String(tasks.filter((task) => isActive(task.status)).length);
    },
    showThread(task, view) {
      watched = task.id;
      el.style.setProperty("--ac", AGENTS[task.id].color);
      el.toggleAttribute("data-live", isActive(task.status));
      el.toggleAttribute("data-acting", task.status === "working");
      part("mark").innerHTML = icon(AGENTS[task.id].glyph);
      part("title").textContent = task.title;
      part("capsule").dataset.state = task.status;
      request.classList.toggle("is-on", view !== null);
      request.inert = view === null;
      if (view) {
        find(request, "b").textContent = view.title;
        find(request, "p").textContent = view.body;
      }
      const next = {
        id: task.id,
        opener: task.opener !== null,
        steps: task.steps.length,
        message: task.message !== null,
        status: task.status,
      };
      const same = next.id === shown.id;
      if (
        same &&
        next.opener === shown.opener &&
        next.steps === shown.steps &&
        next.message === shown.message &&
        next.status === shown.status
      )
        return;
      const fresh =
        same && next.message && !shown.message
          ? "message"
          : same && next.steps > shown.steps
            ? "step"
            : null;
      shown = next;
      feed.innerHTML = `<div class="ip-feed__in">${feedOf(task, fresh)}</div>`;
    },
    showPush(message) {
      push.classList.toggle("is-on", message !== null);
      push.inert = message === null;
      if (message === null) return;
      find(push, "b").textContent = message.title;
      find(push, "span").textContent = message.text;
    },
    tap(target) {
      const at = target.getBoundingClientRect();
      const frame = screen.getBoundingClientRect();
      const scale = frame.width / screen.offsetWidth;
      finger.style.left = `${(at.left - frame.left + at.width / 2) / scale}px`;
      finger.style.top = `${(at.top - frame.top + at.height / 2) / scale}px`;
      restart(finger, "is-tap");
    },
  };
}
