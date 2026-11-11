import { find, reducedMotion, restart } from "../dom.js";
import type { AgentId } from "./agents.js";
import type { Clock } from "./clock.js";
import type { FeedItem, Phone, RequestView, Status, TaskView } from "./phone.js";
import { GROUP } from "./geometry.js";
import type { Point, Side, Stage } from "./stage.js";

export interface Request {
  readonly title: string;
  readonly body: string;
  /** What the card says after each answer. */
  readonly allowed: string;
  readonly denied: string;
  /** Hook on the Mac that Allow sends its spark to. */
  readonly spark?: string;
  onAllow(): void;
  onDeny(): void;
}

/** What a scene can do. Scenes drive the DOM through these; CSS reacts to the flags. */
export interface SceneApi {
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
  /** Moves this agent's cursor to a point on a hook. `frame` is the hook the phone's live view centers on instead. */
  go(hook: string, fx?: number, fy?: number, frame?: string): void;
  click(): void;
  /** Adds a line to this agent's activity on the phone. */
  step(text: string, kind?: FeedItem["kind"]): void;
  status(status: Status): void;
  title(task: string): void;
  /** One short callout, shown only while the phone follows this agent by itself. `hook` is a Mac hook, or `phone:live`, `phone:request`, `phone:composer`, `phone:banner`. */
  label(
    text: string,
    hook: string,
    fx: number,
    fy: number,
    side: Side,
    gap: number,
    ms?: number,
  ): void;
  /** A banner on the phone from this agent. */
  notify(text: string): void;
  ask(request: Request): void;
  /** The person types `text` into the phone's composer and sends it. */
  say(text: string, then: () => void): void;
  /** Clears everything this scene changed and runs it again. */
  restart(afterMs: number): void;
}

export interface Scene {
  readonly agent: AgentId;
  readonly task: string;
  /** Nominal running time of one pass, for the progress bar on the agent's tab. */
  readonly length: number;
  /** The agent's windows: `.win` elements placed inside its 700x540 group. */
  readonly windows: string;
  /** Menu bar titles per `data-win`, app name first. */
  readonly menus: Readonly<Record<string, readonly string[]>>;
  run(api: SceneApi): void;
}

export interface Env {
  readonly clock: Clock;
  readonly stage: Stage;
  readonly phone: Phone;
  /** This agent's group on the Mac, then in the phone's live view. */
  copies(id: AgentId): readonly HTMLElement[];
  progressBar(id: AgentId): HTMLElement;
  /** The agent's task screen is open on the phone. */
  watching(id: AgentId): boolean;
  /** The phone is following this agent's story by itself. */
  following(id: AgentId): boolean;
  /** Redraw the phone and tabs. */
  update(): void;
  openTask(id: AgentId): void;
  showList(): void;
}

export interface Runner {
  readonly scene: Scene;
  readonly task: TaskView;
  readonly request: RequestView | null;
  readonly banner: string | null;
  readonly menu: readonly string[];
  /** Where the phone's live view should center, in this group's points. */
  readonly point: Point;
  start(): void;
  answer(answer: "allow" | "deny"): void;
  /** The visitor just opened this agent: a waiting request gets a few seconds, then allows itself. */
  arrive(): void;
  /** The visitor stopped watching this agent: a waiting request goes back to waiting for them. */
  leave(): void;
  dismissBanner(): void;
}

const PHONE_PARTS = ["live", "request", "composer", "banner"] as const;

export function createRunner(scene: Scene, env: Env): Runner {
  const id = scene.agent;
  const { clock, phone, stage } = env;
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
  const feed: FeedItem[] = [];
  let title = scene.task;
  let status: Status = "idle";
  let request: (Request & { state: RequestView["state"] }) | null = null;
  let banner: string | null = null;
  /** Bumped whenever the visitor arrives or leaves, so an auto-answer armed before that never fires. */
  let visit = 0;
  let point: Point = [GROUP.width / 2, 200];
  let progress: Animation | null = null;

  const at = (ms: number, run: () => void): void => clock.at(ms, run, id);
  const settleInstantly = (): void => {
    if (reducedMotion) clock.flush(id);
  };
  const hooks = (hook: string): HTMLElement[] =>
    copies.flatMap((copy) => [...copy.querySelectorAll<HTMLElement>(`[data-h="${hook}"]`)]);
  const onMac = (hook: string): HTMLElement => find(mac, `[data-h="${hook}"]`);
  const inGroup = (el: Element, fx: number, fy: number): Point => {
    const at = el.getBoundingClientRect();
    const frame = mac.getBoundingClientRect();
    const scale = frame.width / GROUP.width;
    return [
      (at.left - frame.left + at.width * fx) / scale,
      (at.top - frame.top + at.height * fy) / scale,
    ];
  };
  const frontWin = (): string => {
    const shell = mac.querySelector<HTMLElement>(":scope > .win.is-front");
    const page = shell?.querySelector<HTMLElement>("[data-win].is-on");
    return page?.dataset.win ?? shell?.dataset.win ?? "";
  };
  const typeInto = (write: (value: string) => void, value: string, done?: () => void): void => {
    if (reducedMotion) {
      write(value);
      done?.();
      return;
    }
    let shown = 0;
    const tick = (): void => {
      shown += 2;
      write(value.slice(0, shown));
      if (shown < value.length) at(30, tick);
      else done?.();
    };
    tick();
  };
  const setStatus = (next: Status): void => {
    status = next;
    const busy = next === "working" || next === "needs";
    copies.forEach((copy) => copy.toggleAttribute("data-busy", busy));
    env.update();
  };

  function settle(answer: "allow" | "deny"): void {
    if (!request) return;
    request.state = answer === "allow" ? "allowed" : "denied";
    env.update();
    if (answer === "allow" && request.spark) stage.spark(phone.allow, onMac(request.spark));
    at(answer === "allow" ? 1000 : 1300, () => {
      const answered = request;
      request = null;
      progress?.play();
      env.update();
      if (answer === "allow") answered?.onAllow();
      else answered?.onDeny();
    });
  }
  /** Nothing is allowed behind the visitor's back: the tap only lands while they are on this task. */
  function allowAfter(ms: number): void {
    const asked = request;
    const armed = ++visit;
    const stillTheirs = (): boolean =>
      request === asked && asked?.state === "open" && visit === armed && env.watching(id);
    at(ms, () => {
      if (!stillTheirs()) return;
      phone.tap(phone.allow);
      at(350, () => {
        if (stillTheirs()) settle("allow");
      });
    });
  }

  const api: SceneApi = {
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
      typeInto((shown) => api.text(hook, shown), value, done);
    },
    front(win) {
      copies.forEach((copy) => {
        const target = find(copy, `[data-win="${win}"]`);
        const shell = target.closest<HTMLElement>(".win") ?? target;
        copy.querySelectorAll(":scope > .win").forEach((other) => {
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
      const at = inGroup(onMac(hook), fx, fy);
      cursors.forEach((cursor) => {
        cursor.style.transform = `translate(${at[0]}px, ${at[1]}px)`;
      });
      point = frame ? inGroup(onMac(frame), 0.5, 0.5) : at;
      env.update();
    },
    click() {
      cursors.forEach((cursor) => restart(cursor, "is-click"));
    },
    step(text, kind = "step") {
      feed.push({ kind, text });
      env.update();
    },
    status: setStatus,
    title(task) {
      title = task;
      env.update();
    },
    label(text, hook, fx, fy, side, gap, ms = 2600) {
      if (reducedMotion || !env.following(id)) return;
      const part = PHONE_PARTS.find((name) => hook === `phone:${name}`);
      if (!part && stage.narrow) return;
      const note = stage.label(text, part ? phone[part] : onMac(hook), fx, fy, side, gap);
      at(ms, () => stage.retire(note));
    },
    notify(text) {
      banner = text;
      env.update();
      const dismiss = (): void => {
        banner = null;
        env.update();
      };
      if (!env.following(id)) return at(4500, dismiss);
      at(1800, () => phone.tap(phone.banner));
      at(2100, () => {
        dismiss();
        if (env.following(id)) env.openTask(id);
      });
    },
    ask(next) {
      request = { ...next, state: "open" };
      progress?.pause();
      setStatus("needs");
      /* The decision waits four seconds for a tap before the demo allows it itself. */
      if (!reducedMotion) allowAfter(4000);
    },
    say(text, then) {
      const send = (): void => {
        phone.compose("");
        feed.push({ kind: "said", text });
        env.update();
        then();
      };
      if (!env.watching(id)) return at(1200, send);
      phone.tap(phone.composer);
      typeInto(phone.compose, text, () =>
        at(400, () => {
          phone.tap(phone.send);
          at(250, send);
        }),
      );
    },
    restart(afterMs) {
      if (reducedMotion) return;
      at(Math.min(1400, afterMs), () => {
        if (env.following(id)) env.showList();
      });
      at(afterMs, () => {
        reset();
        run();
      });
    },
  };

  function reset(): void {
    clock.clear(id);
    flags.forEach((name) => copies.forEach((copy) => copy.removeAttribute(`data-${name}`)));
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
    feed.length = 0;
    title = scene.task;
    request = null;
    banner = null;
    setStatus("idle");
  }
  function run(): void {
    progress?.cancel();
    progress = env
      .progressBar(id)
      .animate([{ width: "0%" }, { width: "100%" }], { duration: scene.length, fill: "forwards" });
    if (reducedMotion) progress.pause();
    scene.run(api);
    settleInstantly();
  }

  return {
    scene,
    get task() {
      return { id, title, status, feed };
    },
    get request() {
      if (!request) return null;
      const answer = request.state === "denied" ? request.denied : request.allowed;
      return { title: request.title, body: request.body, state: request.state, answer };
    },
    get banner() {
      return banner;
    },
    get menu() {
      return scene.menus[frontWin()] ?? [];
    },
    get point() {
      return point;
    },
    start: run,
    answer(answer) {
      if (request?.state !== "open" || !env.watching(id)) return;
      visit += 1;
      settle(answer);
      settleInstantly();
    },
    arrive() {
      if (request?.state === "open" && !reducedMotion) allowAfter(5000);
    },
    leave() {
      visit += 1;
    },
    dismissBanner() {
      banner = null;
    },
  };
}
