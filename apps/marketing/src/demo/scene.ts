import { find, reducedMotion, restart } from "../dom.js";
import type { AgentId } from "./agents.js";
import type { Clock } from "./clock.js";
import type { Opener, Phone, RequestView, Status, Step, TaskView, View } from "./phone.js";

export type Point = readonly [number, number];

export interface Request extends RequestView {
  onAllow(): void;
  onDeny(): void;
}

/** What a scene can do. Scenes drive the DOM through these; CSS reacts to the flags. */
export interface SceneApi {
  /** This is the demo's first play, which opens on the phone alone before the Mac comes in. */
  readonly intro: boolean;
  /** Schedules `run` after `ms` on this scene's track of the shared clock. */
  at(ms: number, run: () => void): void;
  /** Toggles `data-<name>` on both copies of this agent's group. */
  flag(name: string, on?: boolean): void;
  /** Sets the text of `[data-h="<hook>"]` in both copies. */
  text(hook: string, value: string): void;
  /** Types `value` into a hook, then calls `done`. */
  type(hook: string, value: string, done?: () => void): void;
  /** Opens and raises `[data-win="<win>"]`: a window, or a tab inside a browser window. */
  front(win: string): void;
  /** Moves this agent's cursor to a point on a hook. `frame` is the hook the phone's live page centers on instead. */
  go(hook: string, fx?: number, fy?: number, frame?: string): void;
  click(): void;
  /** Adds a step to this agent's thread on the phone. */
  step(text: string, icon?: Step["icon"], detail?: string): void;
  /** Starts a step of the story's header: 1 on the phone, 2 the work on the Mac, 3 the request. Its line fills over about `ms`. */
  stage(step: 1 | 2 | 3, ms: number): void;
  /** A push from this agent. The phone taps it and opens this agent's thread. */
  notify(text: string): void;
  ask(request: Request): void;
  /** The agent's closing message lands in its thread, and the story is over. */
  finish(message: string, outcome?: "done" | "stopped"): void;
}

export interface Scene {
  readonly agent: AgentId;
  readonly task: string;
  /** With `from`, a trigger starts the story. Without, the person dictates it on the phone first. */
  readonly opener: Opener;
  /** The story's three steps for the header above the stage: phone, Mac, phone. */
  readonly beats: readonly string[];
  /** Nominal running time of one pass, for the progress ring on the agent's tab. */
  readonly length: number;
  /** The agent's windows, placed in desktop points. */
  readonly windows: string;
  /** Menu bar titles per `data-win`, app name first. */
  readonly menus: Readonly<Record<string, readonly string[]>>;
  run(api: SceneApi): void;
}

export interface Env {
  readonly clock: Clock;
  readonly phone: Phone;
  /** This agent's group on the Mac, then in the phone's live page. */
  copies(id: AgentId): readonly HTMLElement[];
  progressRing(id: AgentId): SVGCircleElement;
  /** The agent's thread is open on the phone. */
  watching(id: AgentId): boolean;
  /** Redraw the phone and tabs. */
  update(): void;
  view(): View;
  intro(): boolean;
  show(view: View): void;
  /** How long until the visitor has left the phone alone long enough for the demo to tap it again. */
  quietFor(): number;
  /** A step of this agent's story has begun; 4 says the story is over. */
  beat(id: AgentId, step: number, ms: number): void;
  /** Shows or clears this agent's push on the phone. */
  push(id: AgentId, text: string | null): void;
  openThread(id: AgentId): void;
  /** This agent's story is over. */
  ended(id: AgentId): void;
}

export interface Runner {
  readonly task: TaskView;
  readonly request: RequestView | null;
  readonly menu: readonly string[];
  /** Where the phone's live page should center, in desktop points. */
  readonly point: Point;
  /** The page the agent is in, in desktop points: left, top, width, height. */
  readonly page: readonly [number, number, number, number];
  /** Clears everything the scene changed and runs it from the top. */
  start(): void;
  /** Halts the story where it is. Its windows keep their last frame until it next starts. */
  stop(): void;
  answer(answer: "allow" | "deny"): void;
  /** The phone changed screens: the demo's own tap on a waiting request starts over. */
  nudge(): void;
}

/** How long a push or a request waits for the visitor before the demo taps it itself. */
const PUSH_WAIT = 1700;
const REQUEST_WAIT = 3200;
const TAP = 320;
/** Between the demo's own taps while it walks to a new task and dictates. */
const BEAT = 650;
const WORD = 170;
/** How long a finished story holds its end state before the next one starts. */
const LINGER = 3400;

export function createRunner(scene: Scene, env: Env): Runner {
  const id = scene.agent;
  const { clock, phone } = env;
  const copies = env.copies(id);
  const [mac] = copies;
  if (!mac) throw new Error(`No group for ${id}`);
  const cursors = copies.map((copy) => find(copy, ":scope > .acur"));
  const initialClasses = copies.flatMap((copy) =>
    [...copy.querySelectorAll(".win, [data-win], [data-for]")].map(
      (el) => [el, el.className] as const,
    ),
  );
  const flags = new Set<string>();
  const texts = new Map<string, string>();
  const steps: Step[] = [];
  /** The person's opening message has been sent, or a trigger sent it. */
  let asked = false;
  let message: string | null = null;
  let status: Status = "idle";
  let request: Request | null = null;
  /** Bumped whenever the phone changes screens, so a tap armed before that never lands. */
  let visit = 0;
  let point: Point = [mac.offsetWidth / 2, mac.offsetHeight / 2];
  let progress: Animation | null = null;

  const at = (ms: number, run: () => void): void => clock.at(ms, run, id);
  const settleInstantly = (): void => {
    if (reducedMotion) clock.flush(id);
  };
  const hooks = (hook: string): HTMLElement[] =>
    copies.flatMap((copy) => [...copy.querySelectorAll<HTMLElement>(`[data-h="${hook}"]`)]);
  const onMac = (hook: string): HTMLElement => find(mac, `[data-h="${hook}"]`);
  const onDesktop = (el: Element, fx: number, fy: number): Point => {
    const box = el.getBoundingClientRect();
    const frame = mac.getBoundingClientRect();
    const scale = frame.width / mac.offsetWidth;
    return [
      (box.left - frame.left + box.width * fx) / scale,
      (box.top - frame.top + box.height * fy) / scale,
    ];
  };
  const frontWin = (): string => {
    const shell = mac.querySelector<HTMLElement>(".win.is-front");
    const page = shell?.querySelector<HTMLElement>("[data-win].is-on");
    return page?.dataset.win ?? shell?.dataset.win ?? "";
  };
  const setStatus = (next: Status): void => {
    status = next;
    const busy = next === "working" || next === "needs";
    copies.forEach((copy) => copy.toggleAttribute("data-busy", busy));
    env.update();
  };

  function settle(answer: "allow" | "deny"): void {
    const answered = request;
    if (!answered) return;
    visit += 1;
    request = null;
    progress?.play();
    setStatus("working");
    at(400, answer === "allow" ? answered.onAllow : answered.onDeny);
  }
  /** The demo's own touch: after `ms`, once the visitor has left the phone alone, and only if the phone hasn't changed screens since `armed`. */
  function touch(ms: number, armed: number, target: Element, then: () => void): void {
    at(ms, () => {
      if (visit !== armed) return;
      const wait = env.quietFor();
      if (wait > 0) return touch(wait, armed, target, then);
      phone.tap(target);
      at(TAP, () => {
        if (visit === armed) then();
      });
    });
  }
  /** Brings the phone to this thread through its push, then calls `then`. */
  function throughPush(text: string, then: () => void): void {
    env.push(id, text);
    touch(PUSH_WAIT, ++visit, phone.push, () => {
      env.openThread(id);
      then();
    });
  }
  /** Nothing is allowed behind the visitor's back: the tap only lands on a request they can see. */
  function arm(): void {
    const open = request;
    if (!open || reducedMotion) return;
    if (!env.watching(id)) return throughPush(open.title, arm);
    touch(REQUEST_WAIT, ++visit, phone.allow, () => {
      if (request === open && env.watching(id)) settle("allow");
    });
  }
  /** The person starts the story: back to the list, a new task, the mic, their words, send. */
  function dictate(): void {
    const armed = ++visit;
    const view = env.view();
    if (view === "home") return;
    if (view === "thread") {
      return touch(BEAT, armed, phone.back, () => {
        env.show("list");
        dictate();
      });
    }
    if (view === "list") {
      return touch(BEAT, armed, phone.newTask, () => {
        env.show("new");
        dictate();
      });
    }
    const words = scene.opener.text.split(" ");
    touch(BEAT, armed, phone.mic, () => {
      phone.dictate("");
      words.forEach((_, index) =>
        at(500 + index * WORD, () => {
          if (visit !== armed) return;
          const elapsed = Math.floor((500 + index * WORD) / 1000);
          phone.dictate(words.slice(0, index + 1).join(" "), elapsed);
        }),
      );
      touch(500 + words.length * WORD + 300, armed, phone.send, begin);
    });
  }
  function begin(): void {
    asked = true;
    phone.dictate(null);
    progress = env.progressRing(id).animate([{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], {
      duration: scene.length,
      fill: "forwards",
    });
    if (reducedMotion) progress.pause();
    if (!scene.opener.from) env.openThread(id);
    setStatus("working");
    scene.run(api);
    settleInstantly();
  }

  const api: SceneApi = {
    get intro() {
      return env.intro();
    },
    at,
    flag(name, on = true) {
      flags.add(name);
      copies.forEach((copy) => copy.toggleAttribute(`data-${name}`, on));
    },
    text(hook, value) {
      const targets = hooks(hook);
      if (!texts.has(hook)) texts.set(hook, targets[0]?.textContent ?? "");
      targets.forEach((target) => {
        target.textContent = value;
      });
    },
    type(hook, value, done) {
      if (reducedMotion) {
        api.text(hook, value);
        done?.();
        return;
      }
      let shown = 0;
      const tick = (): void => {
        shown += 2;
        api.text(hook, value.slice(0, shown));
        if (shown < value.length) at(30, tick);
        else done?.();
      };
      tick();
    },
    front(win) {
      copies.forEach((copy) => {
        const target = find(copy, `[data-win="${win}"]`);
        const shell = target.closest<HTMLElement>(".win") ?? target;
        copy.querySelectorAll(".win").forEach((other) => {
          other.classList.toggle("is-front", other === shell);
        });
        shell.classList.add("is-open");
        if (target === shell) return;
        shell.querySelectorAll<HTMLElement>("[data-win], [data-for]").forEach((part) => {
          part.classList.toggle("is-on", (part.dataset.win ?? part.dataset.for) === win);
        });
      });
      env.update();
    },
    go(hook, fx = 0.5, fy = 0.5, frame) {
      const to = onDesktop(onMac(hook), fx, fy);
      /* Its first move of a story appears in place instead of gliding in from wherever it was last. */
      const appearing = !mac.hasAttribute("data-pointing");
      cursors.forEach((cursor) => {
        cursor.style.transition = appearing ? "none" : "";
        cursor.style.transform = `translate(${to[0]}px, ${to[1]}px)`;
        if (appearing) void cursor.offsetWidth;
        cursor.style.transition = "";
      });
      copies.forEach((copy) => copy.toggleAttribute("data-pointing", true));
      point = frame ? onDesktop(onMac(frame), 0.5, 0.5) : to;
      env.update();
    },
    click() {
      cursors.forEach((cursor) => restart(cursor, "is-click"));
    },
    step(text, icon = "globe", detail) {
      steps.push({ icon, text, ...(detail ? { detail } : {}) });
      env.update();
    },
    stage: (step, ms) => env.beat(id, step, ms),
    notify(text) {
      if (env.watching(id)) return;
      if (reducedMotion) return env.openThread(id);
      throughPush(text, () => {});
    },
    ask(next) {
      request = next;
      progress?.pause();
      setStatus("needs");
      if (reducedMotion && !env.watching(id)) env.openThread(id);
      arm();
    },
    finish(text, outcome = "done") {
      message = text;
      env.beat(id, 4, 0);
      setStatus(outcome);
      if (!reducedMotion) at(LINGER, () => env.ended(id));
    },
  };

  function reset(): void {
    clock.clear(id);
    visit += 1;
    flags.forEach((name) => copies.forEach((copy) => copy.removeAttribute(`data-${name}`)));
    copies.forEach((copy) => copy.removeAttribute("data-pointing"));
    flags.clear();
    texts.forEach((value, hook) =>
      hooks(hook).forEach((target) => {
        target.textContent = value;
      }),
    );
    texts.clear();
    initialClasses.forEach(([el, className]) => {
      el.className = className;
    });
    steps.length = 0;
    asked = false;
    phone.dictate(null);
    message = null;
    request = null;
    progress?.cancel();
    setStatus("idle");
  }

  return {
    get task() {
      const worked = `Worked for ${Math.round(scene.length / 1000)}s`;
      const opener = asked ? scene.opener : null;
      return { id, title: scene.task, status, opener, steps, message, worked };
    },
    get request() {
      return request;
    },
    get menu() {
      return scene.menus[frontWin()] ?? [];
    },
    get point() {
      return point;
    },
    get page() {
      const shell = find(mac, ".win.is-front");
      const [left, top] = onDesktop(shell.querySelector(".br-pages") ?? shell, 0, 0);
      const [right, bottom] = onDesktop(shell, 1, 1);
      return [left, top, right - left, bottom - top] as const;
    },
    start() {
      reset();
      if (scene.opener.from || reducedMotion) return begin();
      /* Step one lasts as long as the person takes: a touch per screen on the way to the mic, their words, send. */
      const touches = { home: 1, new: 1, list: 2, thread: 3 }[env.view()];
      const words = scene.opener.text.split(" ").length;
      env.beat(id, 1, touches * (BEAT + TAP) + 500 + words * WORD + 300 + TAP + 600);
      dictate();
    },
    stop() {
      clock.clear(id);
      visit += 1;
      request = null;
      progress?.cancel();
      phone.dictate(null);
      setStatus("idle");
    },
    answer(answer) {
      if (!request || !env.watching(id)) return;
      settle(answer);
      settleInstantly();
    },
    nudge() {
      visit += 1;
      if (asked) arm();
      else if (!scene.opener.from) dictate();
    },
  };
}
