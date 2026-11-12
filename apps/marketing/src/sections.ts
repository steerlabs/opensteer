import { browser } from "./demo/apps/browser.js";
import { calendar } from "./demo/apps/calendar.js";
import { gmail } from "./demo/apps/gmail.js";
import { hubspot } from "./demo/apps/hubspot.js";
import { stripe } from "./demo/apps/stripe.js";
import { zendesk } from "./demo/apps/zendesk.js";
import { group } from "./demo/desktop.js";
import { createPhone, PHONE, type TaskView } from "./demo/phone.js";
import { byId, find, reducedMotion, restart } from "./dom.js";

function nav(): void {
  const bar = byId("nav");
  addEventListener("scroll", () => bar.classList.toggle("is-scrolled", scrollY > 8), {
    passive: true,
  });
}

function reveal(): void {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  document.querySelectorAll(".reveal").forEach((el) => seen.observe(el));
}

/** Runs `play` each time `root` scrolls into view, and `stop` when it leaves, so nothing animates offscreen. */
function whileVisible(root: Element, play: () => void, stop: () => void): void {
  new IntersectionObserver(
    ([entry]) => {
      stop();
      if (entry?.isIntersecting) play();
    },
    { threshold: 0.3 },
  ).observe(root);
}

const TABS = [stripe, gmail, hubspot, zendesk, calendar];
const NARROW = "(max-width: 720px)";

/** Chrome's top, cropped: the agent's cursor goes from tab to tab, and every site is already signed in. */
function signedIn(): void {
  const root = byId("signedShot");
  root.innerHTML = `<div class="shot__in">${group("support", "Dana's double charge", browser("left:0;top:0;width:1200px;height:708px", TABS))}</div>`;
  const inner = find(root, ".shot__in");
  const agent = find(inner, ".grp");
  const cursor = find(agent, ".acur");
  ["data-on", "data-busy", "data-pointing"].forEach((name) => agent.toggleAttribute(name, true));
  const narrow = matchMedia(NARROW);
  let scale = 1;
  let at = 0;
  let timers: number[] = [];

  const point = (): void => {
    const tab = find(inner, `.br-tab[data-for="${TABS[at]?.id}"]`);
    const box = tab.getBoundingClientRect();
    const frame = inner.getBoundingClientRect();
    const x = (box.left - frame.left + box.width * 0.5) / scale;
    const y = (box.top - frame.top + box.height * 0.6) / scale;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  };
  const open = (): void => {
    const id = TABS[at]?.id;
    inner.querySelectorAll<HTMLElement>("[data-win], [data-for]").forEach((part) => {
      if (part.classList.contains("win")) return;
      part.classList.toggle("is-on", (part.dataset.win ?? part.dataset.for) === id);
    });
  };
  const fit = (): void => {
    scale = root.clientWidth / (narrow.matches ? 660 : 1200);
    inner.style.transform = `scale(${scale})`;
    point();
  };
  new ResizeObserver(fit).observe(root);
  fit();
  if (reducedMotion) return;
  const stop = (): void => {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
  };
  const step = (): void => {
    at = (at + 1) % TABS.length;
    point();
    timers = [
      window.setTimeout(() => {
        restart(cursor, "is-click");
        open();
      }, 750),
      window.setTimeout(step, 2600),
    ];
  };
  whileVisible(
    root,
    () => {
      timers = [window.setTimeout(step, 1200)];
    },
    stop,
  );
}

const SLACK = `<div class="slack">
  <div class="slack__bar"><i class="slack__app"><span class="orb"></span></i>Opensteer<em>APP</em></div>
  <div class="slack__feed">
    <div class="slack__msg"><i>AR</i><div><b>Alex Rivera</b><time>9:41 AM</time><p>Refund Dana's duplicate charge.</p></div></div>
    <div class="slack__msg" data-part="reply" hidden><i class="slack__app"><span class="orb"></span></i><div><b>Opensteer</b><em>APP</em><time>9:42 AM</time><p>Refunded $480 to Northwind and replied to Dana. Ticket #4821 is solved.</p></div></div>
  </div>
  <div class="slack__box">Message Opensteer</div>
</div>`;

const ASKED: TaskView = {
  id: "support",
  title: "Dana's double charge",
  status: "needs",
  opener: { text: "Refund Dana's duplicate charge." },
  steps: [
    { icon: "globe", text: "Opened ticket #4821 in Zendesk" },
    { icon: "globe", text: "Looked up Northwind in Stripe" },
  ],
  message: null,
  worked: "Worked for 21s",
};
const ANSWERED: TaskView = {
  ...ASKED,
  status: "done",
  message: "I refunded the extra $480 and replied to Dana. Ticket #4821 is solved.",
};
const REQUEST = {
  title: "Refund $480 to Northwind?",
  body: "Duplicate charge for invoice 2291 on Nov 3, Visa •••• 4242.",
};

/** Asked in Slack, approved on the phone, answered in Slack. */
function steer(): void {
  const root = byId("steerShot");
  root.innerHTML = `<div class="steer__phone">${PHONE}</div>${SLACK}`;
  const reply = find(root, '[data-part="reply"]');
  let timers: number[] = [];
  const stop = (): void => {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
  };
  const allowed = (): void => {
    phone.showThread(ANSWERED, null);
    reply.hidden = false;
    restart(reply, "is-new");
  };
  const phone = createPhone(find(root, ".iphone"), {
    pick() {},
    back() {},
    push() {},
    answer() {
      stop();
      allowed();
    },
  });
  phone.setView("thread");
  if (reducedMotion) return allowed();
  const play = (): void => {
    reply.hidden = true;
    phone.showThread({ ...ASKED, status: "working" }, null);
    timers = [
      window.setTimeout(() => phone.showThread(ASKED, REQUEST), 1200),
      window.setTimeout(() => phone.tap(phone.allow), 4200),
      window.setTimeout(allowed, 4520),
      window.setTimeout(play, 10000),
    ];
  };
  whileVisible(root, play, stop);
}

export function startSections(): void {
  document.documentElement.classList.add("js");
  nav();
  reveal();
  signedIn();
  steer();
}
