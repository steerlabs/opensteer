import "./phone.css";
import { find, icon, reducedMotion, restart } from "../dom.js";

/**
 * The hero phone: the Opensteer app showing a connected agent's task. The agent works in a browser
 * profile it was given, asks before it changes something, and the person answers or stops it.
 * Every word on the phone is the app's own copy (`.opensteer/overhaul/design/copy.json`).
 */

const AGENT = "Claude";
const PROFILE = "Travel";
const DEVICE = "Mac mini";
const SITE = "the airline's site";

const STATUS_BAR = `<div class="ip-status"><b>9:41</b><span><svg viewBox="0 0 18 12"><path d="M1 8.5h2.5V11H1zM5.5 6H8v5H5.5zM10 3.5h2.5V11H10zM14.5 1H17v10h-2.5z" fill="currentColor"/></svg><svg viewBox="0 0 16 16"><use href="#m-wifi"/></svg><svg viewBox="0 0 25 12"><use href="#m-batt"/></svg></span></div>`;

const act = (id: string, text: string): string =>
  `<div class="tk-act" data-act="${id}" hidden>${icon("i-globe")}<span>${text}</span><b class="tk-chip"></b></div>`;

const PHONE = `<div class="iphone" role="group" aria-label="The Opensteer app on a phone">
  <div class="ip-screen">
    <div class="ip-island"></div>
    ${STATUS_BAR}
    <div class="tk">
      <div class="tk-head">${icon("m-chevl")}<div><b>Book the Lisbon flight</b><small>Connected agent · claude.ai</small></div></div>
      <div class="tk-feed" aria-live="polite">
        ${act("open", `Opened ${SITE}`)}
        ${act("search", `Ran a script on ${SITE}`)}
        ${act("book", `Ran a script on ${SITE}`)}
        ${act("confirm", "Opened the confirmation page")}
      </div>
      <p class="tk-gone" hidden>No longer needed: ${AGENT} stopped.</p>
      <div class="tk-ask" hidden>
        <div class="tk-ask__who"><span class="amark amark--sm" aria-hidden="true">C</span>${AGENT}</div>
        <p class="tk-ask__q">Run a script on ${SITE}?</p>
        <p class="tk-ask__ctx">${PROFILE} · ${DEVICE}</p>
        <p class="tk-ask__says">${AGENT} says: Book the 9:40 flight to Lisbon you picked.</p>
        <div class="tk-ask__btns"><button type="button" data-answer="deny">Don’t allow</button><button type="button" data-answer="allow">Allow once</button></div>
        <p class="tk-ask__fine">${AGENT} is told your answer. Allowing this once doesn’t give it any more access.</p>
      </div>
      <div class="tk-bar"><span class="amark" aria-hidden="true">C</span><span class="tk-bar__text"></span><button type="button" data-stop>${icon("i-stop")}Stop ${AGENT}</button></div>
    </div>
    <button class="ip-push" type="button"><span class="ip-icon" aria-hidden="true"><span class="orb"></span></span><div><b>${AGENT} needs you</b><span>Run a script on ${SITE} · ${PROFILE}</span></div><time>now</time></button>
    <span class="ip-finger"></span>
    <div class="ip-home"></div>
  </div>
</div>`;

type Tone = "ok" | "warn" | "muted" | "";
type Bar = "working" | "idle" | "stopped";
type Side = "working" | "needs" | "idle";

/** How long the demo keeps its own fingers off the phone after the visitor touches it. */
const VISITOR_QUIET = 9000;

export function mountWatch(root: HTMLElement, side: HTMLElement | null, hint: HTMLElement): void {
  root.innerHTML = PHONE;
  const phone = find(root, ".iphone");
  const screen = find(phone, ".ip-screen");
  const push = find<HTMLButtonElement>(phone, ".ip-push");
  const ask = find(phone, ".tk-ask");
  const gone = find(phone, ".tk-gone");
  const bar = find(phone, ".tk-bar");
  const barText = find(bar, ".tk-bar__text");
  const stopButton = find<HTMLButtonElement>(bar, "[data-stop]");
  const allowButton = find<HTMLButtonElement>(ask, '[data-answer="allow"]');
  const finger = find(phone, ".ip-finger");
  const row = (id: string): HTMLElement => find(phone, `[data-act="${id}"]`);

  let timers: number[] = [];
  let visible = false;
  let paused = false;
  let quietUntil = 0;

  const later = (ms: number, run: () => void): void => {
    timers.push(window.setTimeout(run, ms));
  };
  const clear = (): void => {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
  };

  function show(id: string, chip: string, tone: Tone = "ok", fresh = true): void {
    const el = row(id);
    if (el.hidden && fresh) restart(el, "is-new");
    el.hidden = false;
    const label = find(el, ".tk-chip");
    label.textContent = chip;
    label.dataset.tone = tone;
  }

  function setBar(state: Bar): void {
    bar.dataset.state = state;
    barText.textContent =
      state === "working"
        ? `${AGENT} is working`
        : state === "idle"
          ? `${AGENT} is idle`
          : "Stopped by you";
    stopButton.hidden = state !== "working";
  }

  function setSide(state: Side): void {
    if (!side) return;
    side.textContent =
      state === "working"
        ? `Working now · ${PROFILE} profile`
        : state === "needs"
          ? "Needs you"
          : `${PROFILE} profile · Supervised`;
    side.dataset.tone = state === "working" ? "good" : state === "needs" ? "attention" : "";
  }

  function setPush(on: boolean): void {
    push.classList.toggle("is-on", on);
    push.inert = !on;
  }

  function setAsk(on: boolean): void {
    ask.hidden = !on;
    ask.inert = !on;
  }

  /** A touch, as a screen recording shows one. */
  function tap(target: Element): void {
    const at = target.getBoundingClientRect();
    const frame = screen.getBoundingClientRect();
    const scale = frame.width / screen.offsetWidth;
    finger.style.left = `${(at.left - frame.left + at.width / 2) / scale}px`;
    finger.style.top = `${(at.top - frame.top + at.height / 2) / scale}px`;
    restart(finger, "is-tap");
  }

  function reset(): void {
    phone.querySelectorAll<HTMLElement>(".tk-act").forEach((el) => (el.hidden = true));
    show("open", "Done", "ok", false);
    show("search", "Done", "ok", false);
    gone.hidden = true;
    setAsk(false);
    setPush(false);
    setBar("working");
    setSide("working");
  }

  function needsYou(): void {
    show("book", "Waiting for you", "warn");
    setSide("needs");
    setPush(true);
  }

  function openAsk(): void {
    setPush(false);
    setAsk(true);
  }

  function allowed(): void {
    setAsk(false);
    setPush(false);
    show("book", "You approved", "");
    setSide("working");
    later(1100, () => show("book", "Done"));
    later(2000, () => show("confirm", "Done"));
    later(3200, () => {
      setBar("idle");
      setSide("idle");
    });
  }

  function declined(): void {
    setAsk(false);
    setPush(false);
    show("book", "You declined", "muted");
    setSide("working");
    later(1600, () => {
      setBar("idle");
      setSide("idle");
    });
  }

  function stopped(): void {
    const asking = !ask.hidden || push.classList.contains("is-on");
    setAsk(false);
    setPush(false);
    gone.hidden = !asking;
    if (!row("book").hidden && find(row("book"), ".tk-chip").dataset.tone === "warn")
      show("book", "Stopped by you", "muted");
    setBar("stopped");
    setSide("idle");
  }

  /** The story on its own: it asks, the phone shows the ask, a finger allows it. */
  function loop(): void {
    clear();
    if (!visible || paused) return;
    const wait = quietUntil - performance.now();
    if (wait > 0) return later(wait, loop);
    reset();
    later(1400, needsYou);
    later(3000, () => tap(push));
    later(3300, openAsk);
    later(6300, () => tap(allowButton));
    later(6620, allowed);
    later(13500, loop);
  }

  /** The visitor's hand takes over; the story starts again once they have let go for a while. */
  function touched(answer: () => void): void {
    clear();
    quietUntil = performance.now() + VISITOR_QUIET;
    answer();
    later(VISITOR_QUIET, loop);
  }

  push.addEventListener("click", () => touched(openAsk));
  ask.addEventListener("click", (event) => {
    const answer = (event.target as Element).closest<HTMLElement>("[data-answer]")?.dataset.answer;
    if (answer === "allow") touched(allowed);
    if (answer === "deny") touched(declined);
  });
  stopButton.addEventListener("click", () => touched(stopped));

  // Moving pictures on a page need a way to hold them still.
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "show__pause";
  const drawPause = (): void => {
    pause.innerHTML = icon(paused ? "i-play" : "i-pause");
    pause.setAttribute("aria-label", paused ? "Play the phone" : "Pause the phone");
  };
  pause.addEventListener("click", () => {
    paused = !paused;
    drawPause();
    if (paused) clear();
    else loop();
  });
  drawPause();

  reset();
  if (reducedMotion) {
    needsYou();
    openAsk();
    return;
  }
  hint.appendChild(pause);
  new IntersectionObserver(
    ([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) loop();
      else clear();
    },
    { threshold: 0.3 },
  ).observe(phone);
}
