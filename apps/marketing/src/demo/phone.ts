import { find, icon, restart } from "../dom.js";
import { AGENTS, type AgentId, engineOf, ORDER } from "./agents.js";

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

const STATUS_WORD: Record<Status, string> = {
  idle: "Watching",
  working: "Working",
  needs: "Needs you",
  done: "Done",
  stopped: "Stopped",
};

const FACE_ID = `<svg viewBox="0 0 40 40" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path class="fid-scan" d="M4 13V9a5 5 0 0 1 5-5h4M27 4h4a5 5 0 0 1 5 5v4M36 27v4a5 5 0 0 1-5 5h-4M13 36H9a5 5 0 0 1-5-5v-4"/><path class="fid-scan fid-face" d="M14 15v3M26 15v3M20 15v6h-1.5M14.5 25.5c3 2.6 8 2.6 11 0"/><path class="fid-ok" d="M12.5 20.5l5.2 5.2 10-11"/></svg>`;

const STATUS_BAR = `<div class="ip-status"><b>9:41</b><span><svg viewBox="0 0 15 11"><path d="M1 8.5h2v2H1zM5 6.5h2v4H5zM9 4h2v6.5H9zM13 1h2v9.5h-2z" fill="currentColor"/></svg><svg viewBox="0 0 16 16"><use href="#m-wifi"/></svg><svg viewBox="0 0 25 12"><use href="#m-batt"/></svg></span></div>`;

const ready = (title: string, when: string): string =>
  `<div class="ip-row ip-row--ready"><span class="tmark">${icon("i-check")}</span><span class="ip-row__title">${title}</span><time>${when}</time></div>`;

/** The Opensteer app: its task list, and one task with a live view of the Mac. */
export const PHONE = `<div class="iphone" data-view="list">
  <div class="ip-screen">
    <div class="ip-island">${FACE_ID}</div>
    ${STATUS_BAR}
    <div class="ip-list">
      <div class="ip-dhead"><b>Opensteer</b>${icon("m-search")}</div>
      <div class="ip-nav"><span class="orb"></span>Chat</div>
      <div class="ip-nav">${icon("m-compose")}New task</div>
      <div class="ip-nav">${icon("m-folder")}Projects</div>
      <div class="ip-nav">${icon("i-clock")}Automations</div>
      <div class="ip-group">Working <span data-part="count"></span></div>
      <div data-part="rows"></div>
      <div class="ip-group">Ready</div>
      ${ready("October invoices paid", "Mon")}
      ${ready("Board deck numbers", "Fri")}
    </div>
    <div class="ip-task">
      <div class="ip-head"><button class="ip-back" type="button" aria-label="Back to your tasks">${icon("m-chevl")}</button><div class="ip-cap"><span class="ip-cap__title"><span class="tmark" data-part="mark"></span><b data-part="title"></b></span><span class="ip-cap__state" data-part="state"><i class="pip"></i><span></span></span></div></div>
      <div class="ip-live"><div class="mirror"></div><span class="ip-live__chip"><i></i>Your MacBook</span></div>
      <span class="ip-grab"></span>
      <div class="ip-feed" data-part="feed"></div>
      <div class="ip-req" data-state="open"><b></b><p></p><div class="ip-req__btns"><button type="button" data-answer="deny">Don’t Allow</button><button type="button" data-answer="allow">Allow</button></div><div class="ip-req__done">${icon("i-check")}<span></span></div></div>
      <div class="ip-composer"><span class="ip-plus">${icon("m-plus")}</span><span class="ip-text"></span><span class="ip-btn">${icon("i-mic")}</span><span class="ip-btn ip-btn--send">${icon("i-up")}</span></div>
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
  face(state: "off" | "scan" | "ok"): void;
}

export function createPhone(el: HTMLElement, events: PhoneEvents): Phone {
  const screen = find(el, ".ip-screen");
  const part = (name: string): HTMLElement => find(el, `[data-part="${name}"]`);
  const banner = find<HTMLButtonElement>(el, ".ip-notif");
  const request = find(el, ".ip-req");
  const feed = part("feed");
  const finger = find(el, ".ip-finger");
  const island = find(el, ".ip-island");
  const text = find(el, ".ip-text");
  const rows = new Map<AgentId, HTMLButtonElement>();
  for (const id of ORDER) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ip-row";
    row.style.setProperty("--ac", AGENTS[id].color);
    row.innerHTML = `<span class="tmark"></span><span class="ip-row__title"></span><span class="ip-row__state"></span><i class="ip-row__spin"></i>`;
    row.addEventListener("click", () => events.pick(id));
    part("rows").appendChild(row);
    rows.set(id, row);
  }
  find(el, ".ip-back").addEventListener("click", events.back);
  banner.addEventListener("click", events.banner);
  request.addEventListener("click", (event) => {
    const answer = (event.target as Element).closest<HTMLElement>("[data-answer]")?.dataset.answer;
    if (answer === "allow" || answer === "deny") events.answer(answer);
  });
  let shown = "";
  return {
    el,
    live: find(el, ".ip-live"),
    mirror: find(el, ".mirror"),
    banner,
    request,
    allow: find(el, '[data-answer="allow"]'),
    composer: find(el, ".ip-composer"),
    send: find(el, ".ip-btn--send"),
    setView(view) {
      el.dataset.view = view;
    },
    showRows(tasks) {
      for (const task of tasks) {
        const row = rows.get(task.id);
        if (!row) continue;
        row.hidden = task.status === "idle";
        row.dataset.state = task.status;
        find(row, ".tmark").innerHTML = icon(engineOf(task.id).mark);
        find(row, ".ip-row__title").textContent = task.title;
        find(row, ".ip-row__state").textContent =
          task.status === "working" ? "" : STATUS_WORD[task.status];
      }
      const busy = tasks.filter((task) => task.status === "working" || task.status === "needs");
      part("count").textContent = String(busy.length);
    },
    showTask(task) {
      el.style.setProperty("--ac", AGENTS[task.id].color);
      part("mark").innerHTML = icon(engineOf(task.id).mark);
      part("title").textContent = task.status === "idle" ? AGENTS[task.id].name : task.title;
      const state = part("state");
      state.dataset.state = task.status;
      find(state, "span").textContent = STATUS_WORD[task.status];
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
    face(state) {
      island.classList.toggle("is-face", state !== "off");
      island.classList.toggle("is-ok", state === "ok");
    },
  };
}
