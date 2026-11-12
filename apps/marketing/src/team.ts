import "./styles/team.css";
import { byId, find, icon, reducedMotion, restart } from "./dom.js";

interface Person {
  readonly name: string;
  readonly first: string;
  readonly color: string;
}

const MAYA: Person = { name: "Maya Chen", first: "Maya", color: "#c58af9" };
const LEO: Person = { name: "Leo Park", first: "Leo", color: "#84b5e0" };
const PRIYA: Person = { name: "Priya Shah", first: "Priya", color: "#dfb36b" };

const LEO_ASK = " check Stripe and refund the duplicate if it's within policy";
const LEO_REPLY =
  "Refunded the duplicate $480.00 on invoice 2291. It's within policy: duplicates under $1,000 don't need finance. Northwind will see it in 5 to 10 days.";
const PRIYA_ASK = "log this on Northwind's account in HubSpot";
const PRIYA_REPLY = "Added a note to Northwind: duplicate charge on 2291, refunded today.";

const mark = (person: Person, agent = false): string =>
  `<span class="mark${agent ? " mark--agent" : ""}" style="--c:${person.color}">${person.first[0]}</span>`;

const chip = (label: string): string => `<span class="tchip">@${label}</span>`;

function message(person: Person, time: string, body: string): string {
  return `<div class="tm">${mark(person)}<div class="tm__body"><div class="tm__who"><b>${person.name}</b><time>${time}</time></div><div class="tm__text">${body}</div></div></div>`;
}

/** An agent's post: its owner's face with the agent badge, a live status card, then the answer. */
function agentPost(owner: Person, time: string): string {
  return `<div class="tm tm--agent">${mark(owner, true)}<div class="tm__body"><div class="tm__who"><b>${owner.first}'s agent</b><span class="tm__badge">Agent</span><time>${time}</time></div>
  <div class="tcard" data-state="working">
    <div class="tcard__top"><span class="tcard__spin"></span><b data-part="state">Working</b><span class="tcard__meta" data-part="meta">on ${owner.first}'s MacBook</span><span class="tcard__open">Open task</span></div>
    <ol class="tcard__steps" data-part="steps"></ol>
    <div class="tcard__ask"><span>Refund <b>$480.00</b> to Northwind?</span><span class="tcard__wait">Waiting on ${owner.first}</span></div>
  </div>
  <div class="tm__text tm__answer" data-part="answer"></div></div></div>`;
}

const channel = (name: string, extra = ""): string =>
  `<div class="tw-row${extra}"><span class="tw-hash">#</span>${name}</div>`;

const WINDOW = `<div class="tw">
  <aside class="tw-side">
    <div class="tw-lights"><i></i><i></i><i></i></div>
    <div class="tw-brand"><b>Opensteer</b><span>${icon("i-mic")}${icon("m-search")}${icon("m-plus")}</span></div>
    <div class="tw-switch"><span class="tw-seg" data-part="tasks">Tasks<i class="tw-new"></i></span><span class="tw-seg is-on"><span class="tw-team">A</span>Acme</span></div>
    <div class="tw-label">Channels</div>
    ${channel("announcements")}
    ${channel("general")}
    ${channel("launch", " is-unread")}
    ${channel("support", " is-on")}
    <div class="tw-row"><span class="tw-hash">${icon("i-lock")}</span>leadership</div>
    <div class="tw-label">Direct messages</div>
    <div class="tw-row is-unread">${mark(MAYA)}Maya Chen<span class="tw-count">1</span></div>
    <div class="tw-row">${mark(PRIYA)}Priya Shah</div>
    <div class="tw-foot"><b>Leo's MacBook</b><span><i></i>Connected · Acme</span></div>
  </aside>
  <div class="tw-main">
    <header class="tw-head"><b>Thread</b><span># support</span><span class="tw-people">${mark(MAYA)}${mark(LEO)}${mark(PRIYA)}<em>14</em></span></header>
    <div class="tw-feed" data-part="feed"></div>
    <div class="tw-compose">
      <div class="tw-pop" data-part="pop">
        <div class="tw-opt is-on"><span class="orb"></span><b>My agent</b><span>Works on your MacBook</span></div>
        <div class="tw-opt">${mark(MAYA)}<b>Maya Chen</b></div>
        <div class="tw-opt">${mark(PRIYA)}<b>Priya Shah</b></div>
      </div>
      <div class="tw-input" data-part="input"></div>
      <div class="tw-tools"><span>@</span><span class="tw-ask"><span class="orb"></span>Ask my agent</span><span class="tw-send">${icon("i-up")}</span></div>
    </div>
  </div>
  <div class="tphone" data-part="phone">
    <div class="tphone__app"><span class="orb"></span>Opensteer<time>now</time></div>
    <b>Needs you · #support</b>
    <p>Refund $480.00 to Northwind for the duplicate charge on invoice 2291?</p>
    <div class="tphone__btns"><span>Don't Allow</span><span class="tphone__allow" data-part="allow">Allow</span></div>
  </div>
</div>`;

const ROOT = message(
  MAYA,
  "2:36 PM",
  "Northwind says they were charged twice for invoice 2291. Can someone take a look?",
);

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

export function mountTeam(): void {
  knowledge();
  const root = byId("teamStage");
  root.innerHTML = WINDOW;
  const feed = find(root, '[data-part="feed"]');
  const input = find(root, '[data-part="input"]');
  const pop = find(root, '[data-part="pop"]');
  const phone = find(root, '[data-part="phone"]');
  const tasks = find(root, '[data-part="tasks"]');
  const timers: number[] = [];
  let visible = false;
  // The thread reads from the top, like the app; once it outgrows the window it follows the newest line.
  new MutationObserver(() => {
    const overflowing = feed.scrollHeight > feed.clientHeight;
    feed.classList.toggle("is-scrolled", overflowing);
    if (overflowing)
      feed.scrollTo({ top: feed.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }).observe(feed, { childList: true, subtree: true, attributeFilter: ["data-state"] });
  let waiting = false;

  /** Runs `run` after `ms`; with reduced motion the scene is laid out at once, already finished. */
  const at = (ms: number, run: () => void): void => {
    if (reducedMotion) run();
    else timers.push(window.setTimeout(run, ms));
  };

  function post(html: string): HTMLElement {
    feed.insertAdjacentHTML("beforeend", html);
    return feed.lastElementChild as HTMLElement;
  }

  function type(text: string, done: () => void): void {
    const typed = document.createElement("span");
    input.appendChild(typed);
    if (reducedMotion) {
      typed.textContent = text;
      done();
      return;
    }
    let shown = 0;
    const tick = window.setInterval(() => {
      shown += 1;
      typed.textContent = text.slice(0, shown);
      if (shown >= text.length) {
        window.clearInterval(tick);
        done();
      }
    }, 24);
    timers.push(tick);
  }

  function card(post: HTMLElement) {
    const el = find(post, ".tcard");
    return {
      step(text: string): void {
        find(el, '[data-part="steps"]').insertAdjacentHTML(
          "beforeend",
          `<li>${icon("i-check")}<span>${text}</span></li>`,
        );
      },
      state(state: "working" | "needs" | "done", label: string, meta: string): void {
        el.dataset.state = state;
        find(el, '[data-part="state"]').textContent = label;
        find(el, '[data-part="meta"]').textContent = meta;
      },
      answer(html: string): void {
        find(post, '[data-part="answer"]').innerHTML = html;
      },
    };
  }

  function play(): void {
    timers.splice(0).forEach((id) => {
      window.clearTimeout(id);
      window.clearInterval(id);
    });
    feed.innerHTML = ROOT;
    feed.scrollTop = 0;
    input.innerHTML = "";
    input.classList.remove("has-text");
    pop.classList.remove("is-on");
    phone.classList.remove("is-on", "is-done");
    tasks.classList.remove("has-new");

    at(1000, () => {
      input.classList.add("has-text");
      input.innerHTML = "<span>@</span>";
      pop.classList.add("is-on");
    });
    at(2100, () => {
      pop.classList.remove("is-on");
      input.innerHTML = chip("My agent");
      type(LEO_ASK, () =>
        at(500, () => {
          input.innerHTML = "";
          input.classList.remove("has-text");
          post(message(LEO, "2:41 PM", `${chip("My agent")}${LEO_ASK}`));
          tasks.classList.add("has-new");
          const leo = card(post(agentPost(LEO, "2:41 PM")));
          at(700, () => leo.step("Read the thread"));
          at(1700, () => leo.step("Found two $480.00 charges for invoice 2291 in Stripe"));
          at(2700, () => leo.step("Checked the Refund policy topic"));
          at(3600, () => {
            leo.state("needs", "Needs Leo", "approval sent to Leo's phone");
            phone.classList.add("is-on");
          });
          at(5200, () => phone.classList.add("is-done"));
          at(5900, () => {
            phone.classList.remove("is-on");
            leo.state("working", "Working", "on Leo's MacBook");
            leo.step("Refunded $480.00 in Stripe");
          });
          at(7000, () => {
            leo.state("done", "Done", "4 steps · 1m 12s");
            leo.answer(`${LEO_REPLY}<span class="tsource">${icon("t-doc")}Refund policy</span>`);
          });
          at(9400, () => {
            post(
              `<div class="tm tm--typing">${mark(PRIYA)}<span>Priya is typing<i></i><i></i><i></i></span></div>`,
            );
          });
          at(10800, () => {
            feed.querySelector(".tm--typing")?.remove();
            post(message(PRIYA, "2:44 PM", `${chip("Priya's agent")}${PRIYA_ASK}`));
            const priya = card(post(agentPost(PRIYA, "2:44 PM")));
            priya.state("working", "Working", "on Priya's MacBook");
            at(800, () => priya.step("Read the thread"));
            at(1800, () => priya.step("Opened Northwind in HubSpot"));
            at(2900, () => {
              priya.state("done", "Done", "2 steps · 38s");
              priya.answer(PRIYA_REPLY);
            });
            at(8000, () => {
              if (reducedMotion) return;
              if (visible) play();
              else waiting = true;
            });
          });
        }),
      );
    });
  }

  if (reducedMotion) {
    play();
    return;
  }
  let started = false;
  new IntersectionObserver(
    ([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (!visible) return;
      if (!started || waiting) {
        started = true;
        waiting = false;
        play();
      }
    },
    { threshold: 0.35 },
  ).observe(root);
}
