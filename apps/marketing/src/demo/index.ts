import "./demo.css";
import { clamp, find, icon, reducedMotion } from "../dom.js";
import { AGENTS, type AgentId, ENGINES, engineOf, ORDER } from "./agents.js";
import { createClock } from "./clock.js";
import { DESKTOP, PAGE, PHONE_ONLY } from "./geometry.js";
import { desktop, group, macbook } from "./desktop.js";
import { createPhone, PHONE, type View } from "./phone.js";
import { createRunner, type Env, type Runner, type Scene } from "./scene.js";
import { engineer } from "./scenes/engineer.js";
import { sales } from "./scenes/sales.js";
import { support } from "./scenes/support.js";
import { createStage, STAGE } from "./stage.js";

const SCENES: Record<AgentId, Scene> = { support, engineer, sales };

/** Where a view of `size` starts so it centers on `at` without leaving a page that starts at `start`. */
const within = (at: number, size: number, start: number, length: number): number =>
  length <= size ? start - (size - length) / 2 : clamp(at - size / 2, start, start + length - size);

/** How long the demo keeps its own fingers off the phone after the visitor touches it. */
const VISITOR_QUIET = 6000;

/** One agent's story plays at a time; a push from the next agent hands the stage over. */
export function mountDemo(root: HTMLElement, rail: HTMLElement): void {
  const groups = ORDER.map((id) => group(id, SCENES[id].task, SCENES[id].windows)).join("");
  root.innerHTML = STAGE.replace("<!--mac-->", macbook(desktop(groups))).replace(
    "<!--phone-->",
    PHONE,
  );
  const wrap = find(root, ".scene-wrap");
  const clock = createClock();
  const stage = createStage(root);
  const macDesk = find(root, ".mb-display .desk");
  const narrow = matchMedia(PHONE_ONLY);

  /** Whose story is running. */
  let active: AgentId = ORDER[0] ?? "support";
  /** Whose windows are on the Mac: the running story's, once a trigger or the person has started it. */
  let onMac: AgentId = active;
  /** Whose thread the phone opens. */
  let shown: AgentId = active;
  let view: View = reducedMotion ? "list" : "home";
  let touchedAt = -Infinity;
  let folding = 0;
  /** The first play opens close on the phone; its first thread pulls back to show the Mac. */
  let intro = !reducedMotion;
  stage.intro(intro);
  const endIntro = (): void => {
    if (!intro) return;
    intro = false;
    stage.intro(false);
  };
  let push: { readonly id: AgentId; readonly text: string } | null = null;
  let pausedByVisitor = false;
  let frozen: Animation[] = [];

  const phone = createPhone(find(root, ".iphone"), {
    pick(id) {
      openThread(id);
      runners[active].nudge();
    },
    back() {
      view = "list";
      render();
      runners[active].nudge();
    },
    push() {
      if (!push) return;
      openThread(push.id);
      runners[active].nudge();
    },
    answer(answer) {
      if (!reducedMotion) {
        pausedByVisitor = false;
        setPaused(false);
      }
      runners[shown].answer(answer);
    },
  });
  phone.mirror.innerHTML = `<div class="desk">${desktop(groups)}</div>`;
  const mirrorDesk = find(phone.mirror, ".desk");

  const tabs = find(root, ".tabs");
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "tabs__pause";
  pause.hidden = reducedMotion;
  pause.addEventListener("click", () => {
    pausedByVisitor = !clock.paused;
    setPaused(!clock.paused);
  });
  tabs.appendChild(pause);
  tabs.insertAdjacentHTML("beforeend", '<i class="tabs__rule" aria-hidden="true"></i>');
  const tabOf = {} as Record<AgentId, HTMLButtonElement>;
  for (const id of ORDER) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "atab";
    tab.style.setProperty("--ac", AGENTS[id].color);
    tab.innerHTML = `<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="atab__track" cx="18" cy="18" r="14" pathLength="100"/><circle class="atab__bar" cx="18" cy="18" r="14" pathLength="100"/></svg>${AGENTS[id].name}<span class="atab__needs">Needs you</span>`;
    tab.addEventListener("click", () => play(id, true));
    tabs.appendChild(tab);
    tabOf[id] = tab;
  }

  const engineButtons = ENGINES.map((engine, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "eng";
    button.setAttribute("aria-label", engine.name);
    button.innerHTML = `${icon(engine.mark)}<span class="eng__label"><span>${engine.name}</span></span>`;
    button.addEventListener("click", () => {
      AGENTS[active].engine = index;
      render();
      /* The app names a thread's engine in its composer once that is opened up, so open it for a moment. */
      phone.expand(true);
      window.clearTimeout(folding);
      folding = window.setTimeout(() => phone.expand(false), 3200);
    });
    rail.appendChild(button);
    return button;
  });

  const env: Env = {
    clock,
    phone,
    copies: (id) => [macDesk, mirrorDesk].map((desk) => find(desk, `.grp[data-agent="${id}"]`)),
    progressRing: (id) => find<SVGCircleElement>(tabOf[id], ".atab__bar"),
    watching: (id) => shown === id && view === "thread",
    update: render,
    view: () => view,
    intro: () => intro,
    show(next) {
      view = next;
      render();
    },
    quietFor: () => Math.max(0, VISITOR_QUIET - (performance.now() - touchedAt)),
    beat(id, step, ms) {
      if (id === active) stage.beat(step, ms);
    },
    push(id, text) {
      push = text === null ? null : { id, text };
      render();
    },
    openThread,
    ended(id) {
      if (id === active) play(ORDER[(ORDER.indexOf(id) + 1) % ORDER.length] ?? id, false);
    },
  };
  const runners = Object.fromEntries(
    ORDER.map((id) => [id, createRunner(SCENES[id], env)]),
  ) as Record<AgentId, Runner>;

  function render(): void {
    phone.setView(view);
    const tasks = ORDER.map((id) => runners[id].task);
    phone.showRows(tasks);
    phone.showThread(runners[shown].task, runners[shown].request);
    phone.showEngine(engineOf(view === "new" ? active : shown));
    phone.showPush(push && { title: runners[push.id].task.title, text: push.text });
    for (const task of tasks) {
      const tab = tabOf[task.id];
      tab.dataset.state = task.status;
      tab.setAttribute("aria-pressed", String(task.id === active));
    }
    engineButtons.forEach((button, index) =>
      button.setAttribute("aria-pressed", String(index === AGENTS[active].engine)),
    );
    const menu = runners[onMac].menu;
    root.querySelectorAll(".menus").forEach((bar) => {
      bar.innerHTML = menu
        .map((item, at) => (at ? `<span>${item}</span>` : `<b>${item}</b>`))
        .join("");
    });
    macDesk.querySelectorAll<HTMLElement>(".grp").forEach((el) => {
      el.toggleAttribute("data-on", el.dataset.agent === onMac);
    });
    mirrorDesk.querySelectorAll<HTMLElement>(".grp").forEach((el) => {
      el.toggleAttribute("data-on", el.dataset.agent === shown);
    });
    if (narrow.matches) {
      const { width, height, scale } = PAGE.open;
      const [x, y] = runners[shown].point;
      const [pageLeft, pageTop, pageWidth, pageHeight] = runners[shown].page;
      const left = within(x, width / scale, pageLeft, pageWidth);
      const top = within(y, height / scale, pageTop, pageHeight);
      mirrorDesk.style.transform = `scale(${scale}) translate(${-left}px, ${-top}px)`;
    } else {
      mirrorDesk.style.transform = `scale(${PAGE.folded.width / DESKTOP.width})`;
    }
  }

  function openThread(id: AgentId): void {
    endIntro();
    push = null;
    shown = id;
    view = "thread";
    if (id === active) onMac = id;
    render();
  }

  /** Starts an agent's story from the top. A visitor's pick opens its thread at once; otherwise its push does. */
  function play(id: AgentId, byVisitor: boolean): void {
    for (const other of ORDER) {
      const { status } = runners[other].task;
      // A story still dictating is idle with taps queued, so only finished ones are left as they are.
      if (other !== id && status !== "done" && status !== "stopped") runners[other].stop();
    }
    active = id;
    if (SCENES[id].opener.from) onMac = id;
    push = null;
    stage.story(SCENES[id].beats);
    if (byVisitor) {
      endIntro();
      touchedAt = -Infinity;
      if (SCENES[id].opener.from) shown = id;
      view = SCENES[id].opener.from ? "thread" : "new";
    }
    runners[id].start();
    render();
  }

  /** Pause holds the clock and every animation and transition on the stage, mid-flight. */
  function setPaused(on: boolean): void {
    if (on !== clock.paused) {
      if (on) {
        clock.pause();
        frozen = root.getAnimations({ subtree: true }).filter((a) => a.playState === "running");
        frozen.forEach((animation) => animation.pause());
      } else {
        clock.resume();
        frozen.forEach((animation) => {
          if (animation.playState === "paused") animation.play();
        });
        frozen = [];
      }
    }
    pause.innerHTML = icon(clock.paused ? "i-play" : "i-pause");
    pause.setAttribute("aria-label", clock.paused ? "Play the demo" : "Pause the demo");
  }

  find(root, ".iphone").addEventListener("pointerdown", (event) => {
    if (event.isTrusted) touchedAt = performance.now();
  });
  narrow.addEventListener("change", render);
  render();
  if (reducedMotion) {
    play(active, false);
    return;
  }
  setPaused(true);
  let started = false;
  // Several thresholds: with 0.2 alone, Chrome missed the stage scrolling into view at some phone widths.
  new IntersectionObserver(
    ([entry]) => {
      if (!entry || entry.intersectionRatio < 0.2) return setPaused(true);
      if (pausedByVisitor) return;
      setPaused(false);
      if (started) return;
      started = true;
      play(active, false);
    },
    { threshold: [0, 0.2, 0.6] },
  ).observe(wrap);
}
