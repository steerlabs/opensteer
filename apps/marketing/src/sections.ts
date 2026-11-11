import { ENGINES } from "./demo/agents.js";
import { byId, find, icon, reducedMotion, restart } from "./dom.js";

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

function engines(): void {
  const list = byId("engines");
  const note = byId("engineNote");
  let picked = 0;
  let cycling = true;
  const buttons = ENGINES.map((engine, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "engine";
    button.innerHTML = `<span class="engine__logo">${icon(engine.mark)}</span><span class="engine__text"><span class="engine__name">${engine.name}</span><span class="engine__sub"><span class="dot dot--done"></span>${engine.plan}</span></span>`;
    button.addEventListener("click", () => {
      cycling = false;
      pick(index);
    });
    list.appendChild(button);
    return button;
  });
  function pick(index: number): void {
    picked = index;
    buttons.forEach((button, at) => button.setAttribute("aria-pressed", String(at === index)));
    note.innerHTML = `Next task runs on <b>${ENGINES[index]?.name ?? ""}</b>. Same thread, same history.`;
  }
  pick(0);
  if (!reducedMotion)
    setInterval(() => {
      if (cycling) pick((picked + 1) % ENGINES.length);
    }, 2400);
}

const SITES = [
  ["Mail", "#e77e76"],
  ["Bank", "#71c6a5"],
  ["CRM", "#84b5e0"],
  ["Docs", "#dfb36b"],
  ["Calendar", "#c58af9"],
  ["Shop", "#e6beb0"],
] as const;

function setup(): void {
  const grid = byId("sites");
  const button = byId<HTMLButtonElement>("connect");
  const count = byId("loginCount");
  const tiles = SITES.map(([name, color]) => {
    const tile = document.createElement("div");
    tile.className = "site";
    tile.innerHTML = `<span class="mark" style="--c:${color}">${name[0]}</span>${name}<span class="site__state">Not connected</span>`;
    grid.appendChild(tile);
    return tile;
  });
  let connected = false;
  function connect(): void {
    if (connected) return;
    connected = true;
    button.textContent = "Connecting…";
    tiles.forEach((tile, index) =>
      setTimeout(
        () => {
          tile.classList.add("is-on");
          find(tile, ".site__state").textContent = "Signed in";
          count.textContent = `${Math.round(((index + 1) / tiles.length) * 128)} saved logins`;
          if (index === tiles.length - 1) {
            button.textContent = "Chrome connected";
            button.disabled = true;
          }
        },
        reducedMotion ? 0 : 260 + index * 220,
      ),
    );
  }
  button.addEventListener("click", connect);
  new IntersectionObserver(
    ([entry], observer) => {
      if (!entry?.isIntersecting) return;
      setTimeout(connect, 900);
      observer.disconnect();
    },
    { threshold: 0.6 },
  ).observe(grid);
}

const RUNS = [
  "Inbox summary sent to your phone · 14 emails, 2 need replies",
  "Invoice from Halcyon filed · payment drafted",
  "PR #317 reviewed · 1 suggestion, tests passing",
];

function automations(): void {
  const log = byId("runlog");
  const next = byId("trigNext");
  function line(text: string): void {
    const row = document.createElement("div");
    row.innerHTML = `${icon("i-check")}<span>${text}</span>`;
    log.prepend(row);
    while (log.children.length > 2) log.lastElementChild?.remove();
  }
  line("PR #316 reviewed · approved, tests passing");
  let seconds = 12;
  let fired = 0;
  setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      const which = fired % RUNS.length;
      const trigger = byId(`trig${which}`);
      trigger.classList.add("trigger--firing");
      setTimeout(() => trigger.classList.remove("trigger--firing"), 1400);
      line(RUNS[which] ?? "");
      fired += 1;
      seconds = 12;
    }
    next.textContent = `in 0:${String(seconds).padStart(2, "0")}`;
  }, 1000);
}

const DEVICES = ["iPhone", "Laptop", "Web", "Slack", "iMessage", "Agent Phone"];

function constellation(): void {
  const root = byId("constellation");
  const lines = byId("lines");
  DEVICES.forEach((device, index) => {
    const angle = (index / DEVICES.length) * Math.PI * 2 - Math.PI / 2;
    const x = 50 + Math.cos(angle) * 40;
    const y = 50 + Math.sin(angle) * 40;
    const chip = document.createElement("span");
    chip.className = "dev";
    chip.style.left = `${x}%`;
    chip.style.top = `${y}%`;
    chip.textContent = device;
    root.appendChild(chip);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", "50");
    line.setAttribute("y1", "50");
    line.setAttribute("x2", String(x));
    line.setAttribute("y2", String(y));
    line.style.animationDelay = `${-index * 0.27}s`;
    lines.appendChild(line);
  });
}

const GRANTS = ["Browser", "Logins", "Files", "Shell", "Payments"] as const;
const CAN: Record<(typeof GRANTS)[number], string> = {
  Browser: "use the browser",
  Logins: "use saved logins",
  Files: "touch files",
  Shell: "run commands",
  Payments: "make payments",
};
const PEOPLE = [
  { name: "Maya", role: "Design", color: "#c58af9", grants: [1, 1, 1, 0, 0] },
  { name: "Dev", role: "Finance", color: "#71c6a5", grants: [1, 1, 1, 0, 1] },
  { name: "Sam", role: "Engineering", color: "#84b5e0", grants: [1, 0, 1, 1, 0] },
  { name: "Priya", role: "Sales", color: "#dfb36b", grants: [1, 1, 0, 0, 0] },
];

function matrix(): void {
  const body = find(document, "#matrix tbody");
  const note = byId("matrixNote");
  PEOPLE.forEach((person, row) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><span class="person"><span class="mark" style="--c:${person.color}">${person.name[0]}</span><span>${person.name}<small>${person.role}</small></span></span></td>` +
      person.grants
        .map(
          (granted, column) =>
            `<td><button class="switch" type="button" role="switch" aria-checked="${granted ? "true" : "false"}" aria-label="${person.name}: ${GRANTS[column]}" data-row="${row}" data-column="${column}"></button></td>`,
        )
        .join("");
    body.appendChild(tr);
  });
  body.addEventListener("click", (event) => {
    const toggle = (event.target as Element).closest<HTMLElement>(".switch");
    if (!toggle) return;
    const on = toggle.getAttribute("aria-checked") !== "true";
    toggle.setAttribute("aria-checked", String(on));
    const person = PEOPLE[Number(toggle.dataset.row)];
    const grant = GRANTS[Number(toggle.dataset.column)];
    if (!person || !grant) return;
    find(note, "span").textContent = on
      ? `${person.name}'s agents can now ${CAN[grant]}. Live on every device.`
      : `${person.name}'s agents can no longer ${CAN[grant]}. Their next action is checked.`;
    restart(note, "is-flash");
  });
}

function copyButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".copy").forEach((button) =>
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(button.dataset.copy ?? "").catch(() => {
        const range = document.createRange();
        if (button.previousElementSibling) range.selectNodeContents(button.previousElementSibling);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      button.innerHTML = icon("i-check");
      setTimeout(() => {
        button.innerHTML = icon("i-copy");
      }, 1400);
    }),
  );
}

export function startSections(): void {
  document.documentElement.classList.add("js");
  nav();
  reveal();
  engines();
  setup();
  automations();
  constellation();
  matrix();
  copyButtons();
}
