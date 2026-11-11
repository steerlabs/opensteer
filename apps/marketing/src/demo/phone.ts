import { find, icon, restart } from "../dom.js";
import { AGENTS, type AgentId, ORDER } from "./agents.js";

export type Status = "idle" | "working" | "needs" | "done" | "stopped";

export interface FeedItem {
  readonly kind: "step" | "stop" | "said";
  readonly text: string;
}

export interface TaskView {
  readonly id: AgentId;
  readonly title: string;
  readonly status: Status;
  readonly feed: readonly FeedItem[];
}

export interface RequestView {
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "allowed" | "denied";
  /** What the card says once it is answered. */
  readonly answer: string;
}

/** What a task row says after its title. A working row shows a spinner instead. */
const ROW_STATE: Record<Status, string> = {
  idle: "",
  working: "",
  needs: "Needs you",
  done: "now",
  stopped: "Couldn’t finish",
};
const isActive = (status: Status): boolean => status === "working" || status === "needs";

const STATUS_BAR = `<div class="ip-status"><b>9:41</b><span><svg viewBox="0 0 15 11"><path d="M1 8.5h2v2H1zM5 6.5h2v4H5zM9 4h2v6.5H9zM13 1h2v9.5h-2z" fill="currentColor"/></svg><svg viewBox="0 0 16 16"><use href="#m-wifi"/></svg><svg viewBox="0 0 25 12"><use href="#m-batt"/></svg></span></div>`;

const nav = (glyph: string, label: string): string => `<div class="ip-nav">${glyph}${label}</div>`;
const finished = (glyph: string, title: string, when: string): string =>
  `<div class="ip-row ip-row--past"><span class="tmark">${icon(glyph)}</span><span class="ip-row__title">${title}</span><span class="ip-row__state">${when}</span></div>`;

/** The Opensteer app: its task list, and one task with a live view of the Mac. */
export const PHONE = `<div class="iphone" data-view="list">
  <div class="ip-screen">
    <div class="ip-island"></div>
    ${STATUS_BAR}
    <div class="ip-list">
      <div class="ip-dhead"><b>Opensteer</b>${icon("m-search")}</div>
      ${nav(`<span class="orb"></span>`, "Chat")}
      ${nav(icon("i-mic"), "Voice")}
      ${nav(icon("m-compose"), "New task")}
      ${nav(icon("m-folder"), "Projects")}
      ${nav(icon("i-clock"), "Automations")}
      <div class="ip-sep"></div>
      <div class="ip-group">Working <span data-part="count"></span></div>
      <div data-part="working"></div>
      <div class="ip-group">Ready</div>
      <div data-part="ready"></div>
      ${finished("t-doc", "October invoices paid", "Mon")}
      ${finished("t-chart", "Board deck numbers", "Fri")}
    </div>
    <div class="ip-task">
      <div class="ip-head"><button class="ip-back" type="button" aria-label="Back to your tasks">${icon("m-chevl")}</button><div class="ip-cap" data-part="capsule"><span class="tmark" data-part="mark"></span><b data-part="title"></b><i class="pip"></i></div></div>
      <div class="ip-live"><div class="mirror"></div><span class="ip-live__chip"><i></i>Your MacBook</span></div>
      <span class="ip-grab"></span>
      <div class="ip-feed" data-part="feed"></div>
      <div class="ip-req" data-state="open"><b></b><p></p><div class="ip-req__btns"><button type="button" data-answer="deny">Don’t Allow</button><button type="button" data-answer="allow">Allow</button></div><div class="ip-req__done">${icon("i-check")}<span></span></div></div>
      <div class="ip-composer"><span class="ip-btn">${icon("m-plus")}</span><span class="ip-text"></span><span class="ip-btn">${icon("i-mic")}</span><span class="ip-btn ip-btn--send">${icon("i-up")}</span></div>
    </div>
    <button class="ip-notif" type="button">${icon("d-os")}<div><b></b><span></span></div><time>now</time></button>
    <span class="ip-finger"></span>
    <div class="ip-home"></div>
  </div>
</div>`;

export interface PhoneEvents {
  pick(id: AgentId): void;
  back(): void;
  banner(): void;
  answer(answer: "allow" | "deny"): void;
}

export interface Phone {
  readonly el: HTMLElement;
  readonly live: HTMLElement;
  readonly mirror: HTMLElement;
  readonly banner: HTMLElement;
  readonly request: HTMLElement;
  readonly allow: HTMLElement;
  readonly composer: HTMLElement;
  readonly send: HTMLElement;
  setView(view: "list" | "task"): void;
  showRows(tasks: readonly TaskView[]): void;
  showTask(task: TaskView): void;
  showRequest(request: RequestView | null): void;
  showBanner(from: string, text: string | null): void;
  compose(text: string): void;
  tap(target: Element): void;
}

export function createPhone(el: HTMLElement, events: PhoneEvents): Phone {
  const screen = find(el, ".ip-screen");
  const part = (name: string): HTMLElement => find(el, `[data-part="${name}"]`);
  const screens = { list: find(el, ".ip-list"), task: find(el, ".ip-task") };
  const back = find<HTMLButtonElement>(el, ".ip-back");
  const banner = find<HTMLButtonElement>(el, ".ip-notif");
  const request = find(el, ".ip-req");
  const live = find(el, ".ip-live");
  const feed = part("feed");
  const finger = find(el, ".ip-finger");
  const text = find(el, ".ip-text");
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
  banner.addEventListener("click", events.banner);
  request.addEventListener("click", (event) => {
    const answer = (event.target as Element).closest<HTMLElement>("[data-answer]")?.dataset.answer;
    if (answer === "allow" || answer === "deny") events.answer(answer);
  });
  let shown = "";
  let watched: AgentId = ORDER[0] ?? "support";
  return {
    el,
    live,
    mirror: find(el, ".mirror"),
    banner,
    request,
    allow: find(el, '[data-answer="allow"]'),
    composer: find(el, ".ip-composer"),
    send: find(el, ".ip-btn--send"),
    setView(view) {
      const leaving = view === "list" ? screens.task : screens.list;
      const hadFocus = leaving.contains(document.activeElement);
      el.dataset.view = view;
      screens.list.inert = view !== "list";
      screens.task.inert = view !== "task";
      if (hadFocus) (view === "task" ? back : rows.get(watched))?.focus({ preventScroll: true });
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
    showTask(task) {
      watched = task.id;
      el.style.setProperty("--ac", AGENTS[task.id].color);
      part("mark").innerHTML = icon(AGENTS[task.id].glyph);
      part("title").textContent = task.status === "idle" ? AGENTS[task.id].name : task.title;
      part("capsule").dataset.state = task.status;
      live.toggleAttribute("data-acting", task.status === "working");
      const key = `${task.id}:${task.feed.length}`;
      if (key === shown) return;
      const grew = shown.startsWith(`${task.id}:`) ? Number(shown.split(":")[1]) : task.feed.length;
      shown = key;
      feed.innerHTML = task.feed
        .map((item, index) => {
          const fresh = index >= grew ? " is-new" : "";
          if (item.kind === "said") return `<div class="ip-said${fresh}">${item.text}</div>`;
          const stop = item.kind === "stop";
          return `<div class="ip-step${stop ? " ip-step--stop" : ""}${fresh}">${icon(stop ? "i-xmark" : "i-check")}<span>${item.text}</span></div>`;
        })
        .join("");
    },
    showRequest(view) {
      request.classList.toggle("is-on", view !== null);
      request.inert = view?.state !== "open";
      if (!view) return;
      request.dataset.state = view.state;
      find(request, "b").textContent = view.title;
      find(request, "p").textContent = view.body;
      find(request, ".ip-req__done span").textContent = view.answer;
    },
    showBanner(from, message) {
      banner.classList.toggle("is-on", message !== null);
      banner.inert = message === null;
      if (message === null) return;
      find(banner, "b").textContent = from;
      find(banner, "span").textContent = message;
    },
    compose(value) {
      text.textContent = value;
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
