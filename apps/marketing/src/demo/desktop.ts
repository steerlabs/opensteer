import { AGENTS, type AgentId } from "./agents.js";

const WALLPAPER = `<svg class="wall" viewBox="0 0 1040 676" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <defs>
    <linearGradient id="wall-base" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c1440"/><stop offset="0.5" stop-color="#1a1150"/><stop offset="1" stop-color="#3b0f3f"/></linearGradient>
    <linearGradient id="wall-warm" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ffb36b"/><stop offset="0.38" stop-color="#ff6f61"/><stop offset="0.72" stop-color="#d43f8d"/><stop offset="1" stop-color="#7b3fe4"/></linearGradient>
    <linearGradient id="wall-cool" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ad0e0"/><stop offset="0.6" stop-color="#3d6df2"/><stop offset="1" stop-color="#5b3fe0"/></linearGradient>
    <linearGradient id="wall-edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffe0a8"/><stop offset="1" stop-color="#ff8f70"/></linearGradient>
    <filter id="wall-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="34"/></filter>
    <filter id="wall-fine" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter>
    <filter id="wall-wide" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="60"/></filter>
  </defs>
  <rect width="1040" height="676" fill="url(#wall-base)"/>
  <ellipse cx="180" cy="90" rx="380" ry="230" fill="#2447c9" opacity="0.55" filter="url(#wall-wide)"/>
  <path d="M-80 250C120 120 330 190 470 300S780 470 1120 330V560C860 620 640 560 470 470S120 380-80 520Z" fill="url(#wall-cool)" opacity="0.85" filter="url(#wall-soft)"/>
  <path d="M-80 600C140 420 330 540 520 440S860 150 1120 190V470C900 420 760 560 560 610S180 650-80 800Z" fill="url(#wall-warm)" filter="url(#wall-soft)"/>
  <path d="M-60 690C160 530 360 620 540 540S860 300 1110 330" fill="none" stroke="url(#wall-edge)" stroke-width="46" stroke-linecap="round" opacity="0.75" filter="url(#wall-fine)"/>
  <path d="M-60 430C140 300 330 360 480 440S800 560 1110 430" fill="none" stroke="#9fe8ff" stroke-width="16" opacity="0.32" filter="url(#wall-fine)"/>
  <ellipse cx="900" cy="650" rx="330" ry="130" fill="#3a0c36" opacity="0.7" filter="url(#wall-wide)"/>
</svg>`;

const use = (id: string): string => `<svg><use href="#${id}"/></svg>`;

const MENU_BAR = `<div class="menubar" aria-hidden="true"><svg class="menubar__sys"><use href="#m-sys"/></svg><span class="menus"></span><span class="menubar__end"><span class="orb"></span><svg class="menubar__batt"><use href="#m-batt"/></svg>${use("m-wifi")}${use("m-search")}${use("m-cc")}<span class="menubar__date"><span>Tue Nov 10</span><span>9:41 AM</span></span></span></div>`;

const DOCK_APPS = ["d-files", "d-web", "d-mail", "d-cols", "d-cal", "d-msgs", "d-term", "d-os"];
const DOCK = `<div class="dock" aria-hidden="true">${DOCK_APPS.map((id) => `<span class="dock__app is-running">${use(id)}</span>`).join("")}<span class="dock__sep"></span><span class="dock__app">${use("d-trash")}</span></div>`;

/** The product's agent cursor: an arrow in the task's color with a white keyline, tagged with the task. */
const cursor = (task: string): string =>
  `<div class="acur"><svg viewBox="0 0 16 18"><path d="M2 2 2 15.2 5.6 11.9 8.1 17.3 10.4 16.3 8 11 13 10.7Z" fill="currentColor" stroke="#fff" stroke-linejoin="round" stroke-width="1.5"/></svg><b>${task}</b></div>`;

/** One agent's windows and its cursor, in desktop points. */
export function group(id: AgentId, task: string, windows: string): string {
  return `<div class="grp" data-agent="${id}" style="--ac:${AGENTS[id].color}">${windows}${cursor(task)}</div>`;
}

/** The desktop's contents. The same markup is drawn on the Mac and, smaller, in the phone's live page. */
export function desktop(groups: string): string {
  return `${MENU_BAR}${groups}${DOCK}`;
}

export function macbook(contents: string): string {
  return `<div class="rig">
  <div class="mb-shadow"></div>
  <div class="mb">
    <div class="mb-base"><div class="mb-deck" aria-hidden="true"><div class="mb-grille mb-grille--l"></div><div class="mb-keys"></div><div class="mb-grille mb-grille--r"></div><div class="mb-pad"></div><div class="mb-front"></div></div></div>
    <div class="mb-lid">
      <div class="mb-notch"><i></i></div>
      <div class="mb-hinge"></div>
      <div class="mb-display"><div class="desk">${WALLPAPER}${contents}</div><div class="mb-glare"></div></div>
    </div>
  </div>
</div>`;
}
