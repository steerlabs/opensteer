import "./demo.css";
import { clamp, find, icon, reducedMotion, restart } from "../dom.js";
import { AGENTS, type AgentId, ENGINES, engineOf, ORDER } from "./agents.js";
import { createClock } from "./clock.js";
import { desktop, group, macbook } from "./desktop.js";
import { createPhone, PHONE } from "./phone.js";
import { createRunner, type Env, type Runner, type Scene } from "./scene.js";
import { engineer } from "./scenes/engineer.js";
import { sales } from "./scenes/sales.js";
import { support } from "./scenes/support.js";
import { createStage, STAGE } from "./stage.js";

const SCENES: Record<AgentId, Scene> = { support, engineer, sales };
/** The agent whose story the phone follows by itself until the visitor takes over. */
const FOLLOWED: AgentId = "support";
/** Where the main slot puts a group on the desktop, and the piece of desktop the phone's live view frames. */
const MAIN = [20, 38] as const;
const FRAME = { width: 452, height: 312 };
const DESKTOP = { width: 1040, height: 676 };

export function mountDemo(root: HTMLElement, rail: HTMLElement): void {
  const groups = ORDER.map((id) => group(id, SCENES[id].windows)).join("");
  root.innerHTML = `${STAGE.replace("<!--mac-->", macbook(desktop(groups))).replace("<!--phone-->", PHONE)}<div class="tabs" role="group" aria-label="Pick an agent to watch"></div>`;
  const wrap = find(root, ".scene-wrap");
  const stage = createStage(wrap);
  const clock = createClock();
  const macDesk = find(root, ".mb-display .desk");
  const region = find(macDesk, ".vp");

  let watched: AgentId = FOLLOWED;
  let view: "list" | "task" = "list";
  let following = true;
  let visible = false;
  let pausedByVisitor = false;
  let frozen: Animation[] = [];
  /** Agents whose waiting-request banner has stepped aside; their tab still says "Needs you". */
  const hushed = new Set<AgentId>();
  const hushing = new Set<AgentId>();

  const bannerOwner = (): AgentId | undefined =>
    ORDER.find((id) => runners[id].banner !== null) ??
    ORDER.find(
      (id) =>
        runners[id].request?.state === "open" &&
        !(watched === id && view === "task") &&
        !hushed.has(id),
    );

  const phone = createPhone(find(root, ".iphone"), {
    pick: (id) => select(id, true),
    back() {
      following = false;
      view = "list";
      stage.clearLabels();
      ORDER.forEach((id) => {
        if (runners[id].request) hushed.add(id);
      });
      render();
    },
    banner() {
      const id = bannerOwner();
      if (!id) return;
      runners[id].dismissBanner();
      select(id, true);
    },
    answer(answer) {
      if (!reducedMotion) {
        pausedByVisitor = false;
        setPaused(false);
      }
      runners[watched].answer(answer);
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
  const tabOf = {} as Record<AgentId, HTMLButtonElement>;
  for (const id of ORDER) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "atab";
    tab.style.setProperty("--ac", AGENTS[id].color);
    tab.innerHTML = `<span class="atab__mark"></span><span class="atab__text"><b>${AGENTS[id].name}</b><span class="atab__task"></span></span><i class="pip"></i><i class="atab__bar"></i>`;
    tab.addEventListener("click", () => select(id, true));
    tabs.appendChild(tab);
    tabOf[id] = tab;
  }

  const engineButtons = ENGINES.map((engine, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "eng";
    button.setAttribute("aria-label", engine.name);
    button.innerHTML = `${icon(engine.mark)}<span>${engine.name}</span>`;
    button.addEventListener("click", () => {
      const owner = ORDER.find((id) => AGENTS[id].engine === index);
      if (!owner) AGENTS[watched].engine = index;
      select(owner ?? watched, true);
      restart(rail, "is-flash");
    });
    rail.appendChild(button);
    return button;
  });

  const env: Env = {
    clock,
    stage,
    phone,
    copies: (id) => [macDesk, mirrorDesk].map((desk) => find(desk, `.grp[data-agent="${id}"]`)),
    progressBar: (id) => find(tabOf[id], ".atab__bar"),
    watching: (id) => watched === id && view === "task",
    following: (id) => following && id === FOLLOWED,
    update: render,
    openTask: (id) => select(id, false),
    showList() {
      view = "list";
      render();
    },
  };
  const runners = Object.fromEntries(
    ORDER.map((id) => [id, createRunner(SCENES[id], env)]),
  ) as Record<AgentId, Runner>;

  function render(): void {
    phone.setView(view);
    stage.scene.dataset.view = view;
    stage.scene.style.setProperty("--ac", AGENTS[watched].color);
    const tasks = ORDER.map((id) => runners[id].task);
    phone.showRows(tasks);
    phone.showTask(runners[watched].task);
    phone.showRequest(view === "task" ? runners[watched].request : null);
    ORDER.forEach((id) => {
      if (runners[id].request) return;
      hushed.delete(id);
      hushing.delete(id);
    });
    const owner = bannerOwner();
    const waiting = owner ? runners[owner].request : null;
    phone.showBanner(
      owner ? AGENTS[owner].name : "",
      owner ? (runners[owner].banner ?? `Needs you: ${waiting?.title ?? ""}`) : null,
    );
    if (owner && runners[owner].banner === null && !hushing.has(owner) && !reducedMotion) {
      hushing.add(owner);
      clock.at(
        3500,
        () => {
          hushed.add(owner);
          render();
        },
        "banner",
      );
    }
    for (const task of tasks) {
      const tab = tabOf[task.id];
      tab.dataset.state = task.status;
      tab.setAttribute("aria-pressed", String(task.id === watched));
      find(tab, ".atab__mark").innerHTML = icon(engineOf(task.id).mark);
      find(tab, ".atab__task").textContent =
        task.status === "needs" ? "Needs you" : task.status === "idle" ? "Watching" : task.title;
    }
    engineButtons.forEach((button, index) =>
      button.setAttribute("aria-pressed", String(index === AGENTS[watched].engine)),
    );
    const menu = runners[watched].menu;
    root.querySelectorAll(".menus").forEach((bar) => {
      bar.innerHTML = menu
        .map((item, at) => (at ? `<span>${item}</span>` : `<b>${item}</b>`))
        .join("");
    });
    const [x, y] = runners[watched].point;
    const cx = clamp(MAIN[0] + x, FRAME.width / 2, DESKTOP.width - FRAME.width / 2);
    const cy = clamp(MAIN[1] + y, FRAME.height / 2, DESKTOP.height - FRAME.height / 2);
    mirrorDesk.style.transform = `translate(${(FRAME.width / 2 - cx) / 2}px, ${(FRAME.height / 2 - cy) / 2}px) scale(0.5)`;
    region.style.transform = `translate(${cx - FRAME.width / 2}px, ${cy - FRAME.height / 2}px)`;
  }

  function select(id: AgentId, byVisitor: boolean): void {
    if (byVisitor) {
      following = id === FOLLOWED;
      stage.clearLabels();
    }
    watched = id;
    view = "task";
    const parked = ORDER.filter((other) => other !== id);
    root.querySelectorAll<HTMLElement>(".grp").forEach((el) => {
      const agent = el.dataset.agent as AgentId;
      el.dataset.slot = agent === id ? "main" : parked.indexOf(agent) === 0 ? "a" : "b";
    });
    phone.compose("");
    render();
    if (byVisitor) runners[id].arrive();
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

  macDesk.addEventListener("click", (event) => {
    const parked = (event.target as Element).closest<HTMLElement>('.grp:not([data-slot="main"])');
    if (parked) select(parked.dataset.agent as AgentId, true);
  });
  stage.beam(phone.live, region, () => visible && view === "task");

  select(FOLLOWED, false);
  view = "list";
  render();
  const start = (): void => ORDER.forEach((id) => runners[id].start());
  if (reducedMotion) {
    start();
    return;
  }
  setPaused(true);
  let started = false;
  new IntersectionObserver(
    ([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (!visible) return setPaused(true);
      if (pausedByVisitor) return;
      setPaused(false);
      if (started) return;
      started = true;
      start();
    },
    { threshold: 0.2 },
  ).observe(wrap);
}
