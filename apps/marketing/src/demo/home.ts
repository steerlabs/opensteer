/** The iPhone's home screen, where the first push of the demo lands. Icons are drawn in the Mac Dock's simplified style. */

const use = (id: string): string => `<svg viewBox="0 0 48 48"><use href="#${id}"/></svg>`;
const art = (background: string, shapes: string): string =>
  `<svg viewBox="0 0 60 60"><rect width="60" height="60" fill="${background}"/>${shapes}</svg>`;

const GRADIENTS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="hg-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f7fe6"/><stop offset="1" stop-color="#7cc4f8"/></linearGradient>
  <linearGradient id="hg-grey" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9d9de"/><stop offset="1" stop-color="#8e8e93"/></linearGradient>
  <linearGradient id="hg-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb5c74"/><stop offset="1" stop-color="#fa233b"/></linearGradient>
  <linearGradient id="hg-green" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#67e36b"/><stop offset="1" stop-color="#27c03f"/></linearGradient>
</defs></svg>`;

const PETALS = [
  "#f9b700",
  "#f5802a",
  "#ec4a4f",
  "#c44fc0",
  "#6a62d9",
  "#3a9be8",
  "#47b96a",
  "#a7c93f",
]
  .map(
    (color, index) =>
      `<ellipse cx="30" cy="17.5" rx="6.2" ry="10.5" fill="${color}" opacity="0.85" transform="rotate(${index * 45} 30 30)"/>`,
  )
  .join("");

const ICONS = {
  photos: art("#fff", PETALS),
  camera: art(
    "url(#hg-grey)",
    `<rect x="11" y="19" width="38" height="26" rx="5" fill="#2b2b2e"/><rect x="22" y="14.5" width="16" height="7" rx="2" fill="#2b2b2e"/><circle cx="30" cy="32" r="8.5" fill="#55555b"/><circle cx="30" cy="32" r="5" fill="#1b1b1d"/>`,
  ),
  maps: art(
    "#e9f0e1",
    `<path d="M0 40 22 26l14 10L60 18V0H0Z" fill="#bfe3a7"/><path d="M-4 52 24 30l12 9L64 16" fill="none" stroke="#fff" stroke-width="7"/><path d="M38 60 46 0" stroke="#f7d154" stroke-width="5"/><circle cx="40" cy="24" r="6.5" fill="#3a82f6" stroke="#fff" stroke-width="2.5"/>`,
  ),
  weather: art(
    "url(#hg-sky)",
    `<circle cx="22" cy="23" r="9.5" fill="#ffd43b"/><path d="M19 43a8 8 0 0 1 1.5-15.8A10.5 10.5 0 0 1 40 26.5 8.3 8.3 0 0 1 41 43Z" fill="#fff"/>`,
  ),
  clock: art(
    "#111113",
    `<circle cx="30" cy="30" r="22.5" fill="#fff"/><path d="M30 30V14M30 30l10 6" stroke="#111113" stroke-width="2.5" stroke-linecap="round"/><path d="M30 30 20 44" stroke="#f0883b" stroke-width="1.5" stroke-linecap="round"/><circle cx="30" cy="30" r="2" fill="#111113"/>`,
  ),
  notes: art(
    "#fff",
    `<rect width="60" height="17" fill="#fbd24a"/><path d="M10 28h40M10 37h40M10 46h28" stroke="#d6d6da" stroke-width="2"/>`,
  ),
  music: art(
    "url(#hg-red)",
    `<path d="M24 41V19l18-4v22" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/><ellipse cx="20" cy="41" rx="5.5" ry="4.5" fill="#fff"/><ellipse cx="38" cy="37" rx="5.5" ry="4.5" fill="#fff"/>`,
  ),
  settings: art(
    "url(#hg-grey)",
    `<circle cx="30" cy="30" r="17" fill="none" stroke="#3a3a3f" stroke-width="7" stroke-dasharray="6.7 4"/><circle cx="30" cy="30" r="12.5" fill="none" stroke="#3a3a3f" stroke-width="3"/><circle cx="30" cy="30" r="4.5" fill="#3a3a3f"/>`,
  ),
  phone: art(
    "url(#hg-green)",
    `<path d="M21.5 15.5c-3 1-5 3.5-4.5 7.5 1.5 11 9.5 19 20.5 20.5 4 .5 6.5-1.5 7.5-4.5l-7.5-5-3.5 3.2c-4.5-2-8.5-6-10.5-10.5l3.2-3.5Z" fill="#fff"/>`,
  ),
} as const;

const app = (label: string, picture: string, extra = ""): string =>
  `<span class="hm-app${extra}"><i>${picture}</i><b>${label}</b></span>`;

const OPENSTEER = app("Opensteer", `<em class="hm-orb"></em>`, " hm-app--os");

const GRID = [
  app("Calendar", use("d-cal")),
  app("Photos", ICONS.photos),
  app("Camera", ICONS.camera),
  app("Maps", ICONS.maps),
  app("Weather", ICONS.weather),
  app("Clock", ICONS.clock),
  app("Notes", ICONS.notes),
  app("Files", use("d-files")),
  app("Music", ICONS.music),
  app("Settings", ICONS.settings),
  app("Numbers", use("d-cols")),
  OPENSTEER,
].join("");

const DOCK = [ICONS.phone, use("d-web"), use("d-msgs"), use("d-mail")]
  .map((picture) => app("", picture))
  .join("");

export const HOME = `<div class="ip-spring" aria-hidden="true">${GRADIENTS}<div class="hm-grid">${GRID}</div><span class="hm-search">Search</span><div class="hm-dock">${DOCK}</div></div>`;
