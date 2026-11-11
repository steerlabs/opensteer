import "./linkedin.css";
import type { BrowserTab } from "./browser.js";
import { PEOPLE, face, type Person } from "./face.js";

const glyph = (path: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="currentColor"/></svg>`;

const SEARCH = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.3 10.3 3.9 3.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const NAV = [
  ["Home", "M3 10.6 12 3.5l9 7.1V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1Z"],
  [
    "My Network",
    "M8.5 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm7.5-.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6ZM1.5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5Zm15.4-6.4c3.2.3 5.6 2.9 5.6 6.4h-5.5c0-2.4-.6-4.5-.1-6.4Z",
  ],
  [
    "Jobs",
    "M9 3.5h6A1.5 1.5 0 0 1 16.5 5v2H20a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 4 7h3.5V5A1.5 1.5 0 0 1 9 3.5Zm.5 3.5h5V5.5h-5Z",
  ],
  [
    "Messaging",
    "M4 3.5h16A1.5 1.5 0 0 1 21.5 5v11a1.5 1.5 0 0 1-1.5 1.5h-8.5l-5.5 4v-4H4A1.5 1.5 0 0 1 2.5 16V5A1.5 1.5 0 0 1 4 3.5Z",
  ],
  [
    "Notifications",
    "M12 2.5a6.5 6.5 0 0 0-6.5 6.5v4.5L3.5 17v1.5h17V17l-2-3.5V9A6.5 6.5 0 0 0 12 2.5ZM9.3 20a2.8 2.8 0 0 0 5.4 0Z",
  ],
] as const;

const TOP_NAV = `<header class="li-nav">
  <i class="li-logo">in</i>
  <span class="li-search">${SEARCH}<span>Search</span></span>
  <nav class="li-icons">${NAV.map(([name, path], index) => `<span${index === 4 ? ' class="li-dot"' : ""}>${glyph(path)}<b>${name}</b></span>`).join("")}<span class="li-me">${face(PEOPLE.alex, "li-face")}<b>Me ▾</b></span></nav>
</header>`;

/* Far and near towers as [x, width, height]; the cover is an evening skyline over the river. */
const FAR = [
  [0, 26, 34],
  [24, 18, 46],
  [40, 30, 30],
  [70, 20, 52],
  [92, 26, 40],
  [150, 22, 44],
  [172, 30, 58],
  [204, 18, 36],
  [228, 26, 48],
  [262, 20, 62],
  [300, 30, 42],
  [334, 22, 54],
  [360, 40, 36],
] as const;
const NEAR = [
  [10, 22, 40],
  [36, 16, 56],
  [56, 26, 30],
  [112, 20, 66],
  [134, 14, 48],
  [186, 24, 72],
  [214, 12, 50],
  [244, 22, 44],
  [280, 18, 80],
  [300, 26, 52],
  [346, 20, 60],
  [372, 26, 34],
] as const;
const BASE = 84;
const towers = (set: readonly (readonly [number, number, number])[], fill: string): string =>
  set
    .map(
      ([x, w, h]) => `<rect x="${x}" y="${BASE - h}" width="${w}" height="${h}" fill="${fill}"/>`,
    )
    .join("");
const windows = NEAR.flatMap(([x, w, h], index) =>
  Array.from({ length: Math.floor(h / 9) }, (_, row) =>
    (row + index) % 3 === 0
      ? ""
      : `<rect x="${x + 3 + ((row * 5 + index * 3) % Math.max(1, w - 6))}" y="${BASE - h + 5 + row * 9}" width="2.4" height="2.4"/>`,
  ),
).join("");

const COVER = `<div class="li-cover"><svg viewBox="0 0 400 104" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
<circle cx="300" cy="62" r="16" fill="#ffe2b0" opacity=".55"/>
${towers(FAR, "#6e7397")}
${towers(NEAR, "#353c5c")}
<g fill="#ffd28f" opacity=".75">${windows}</g>
<rect y="${BASE}" width="400" height="20" fill="#3a4466"/>
<g opacity=".35">${NEAR.map(([x, w, h]) => `<rect x="${x}" y="${BASE + 1}" width="${w}" height="${Math.min(h / 4, 18)}" fill="#1f2640"/>`).join("")}</g>
<path d="M0 ${BASE + 6}h400M30 ${BASE + 11}h140M210 ${BASE + 14}h160" stroke="#f6b98a" stroke-width=".8" opacity=".5"/>
</svg></div>`;

const CONNECT = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2 13.5c.4-2.6 2.1-4 4.5-4s4.1 1.4 4.5 4M13 5.5v4M11 7.5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

const pic = (person: Person): string => face(person, "li-face");

const peer = (person: Person, name: string, role: string): string =>
  `<div class="li-peer">${pic(person)}<div><b>${name}</b><span>${role}</span><em class="li-btn">${CONNECT}Connect</em></div></div>`;

export const linkedin: BrowserTab = {
  id: "linkedin",
  title: "Priya Raman | LinkedIn",
  url: "www.linkedin.com<em>/in/priya-raman/</em>",
  mark: `<i class="br-fav" style="background:#0a66c2">in</i>`,
  page: `<div class="li">${TOP_NAV}
  <div class="li-body">
    <main class="li-main">
      <section class="li-card li-top">
        ${COVER}
        <div class="li-photo">${pic(PEOPLE.priya)}</div>
        <div class="li-intro">
          <div class="li-who">
            <h4>Priya Raman <span>· 1st</span></h4>
            <p class="li-headline" data-h="li-headline">VP Operations at Acme Corp | Building ops teams that scale</p>
            <p class="li-meta">Austin, Texas, United States · <a>Contact info</a></p>
            <p class="li-meta"><a>500+ connections</a></p>
          </div>
          <ul class="li-orgs"><li><i class="li-co">A</i>Acme Corp</li><li><i class="li-co li-co--edu">UT</i>UT Austin</li></ul>
        </div>
        <p class="li-mutual"><span class="li-faces">${pic(PEOPLE.jordan)}${pic(PEOPLE.sam)}</span>Jordan Lee, Sam Okafor and 4 other mutual connections</p>
        <div class="li-actions"><span class="li-btn li-btn--primary">Message</span><span class="li-btn li-btn--quiet">More</span></div>
      </section>
      <section class="li-card">
        <h5>About</h5>
        <p>I build operations teams that grow fast without losing the human part. I joined Acme Corp in September to lead operations across our three distribution centers.</p>
      </section>
      <section class="li-card li-activity">
        <h5>Activity</h5>
        <span class="li-followers">2,318 followers</span>
        <div class="li-pills"><span class="is-on">Posts</span><span>Comments</span><span>Images</span></div>
        <article class="li-post" data-h="li-post">
          <p class="li-post__by">Priya Raman posted this · 2w</p>
          <p class="li-post__text">Since joining Acme, I've watched our ops team grow to <mark data-h="li-team">120 people</mark>. <mark class="li-mark--late" data-h="li-onboard">What made it work was onboarding: every new hire ships something real in week one, with a buddy beside them.</mark></p>
          <p class="li-post__stats"><i class="li-react"></i><i class="li-react li-react--love"></i>214 · 38 comments</p>
        </article>
      </section>
      <section class="li-card li-exp">
        <h5>Experience</h5>
        <div class="li-job"><i class="li-co">A</i><div><b>VP Operations</b><span>Acme Corp · Full-time</span><span class="li-when"><mark data-h="li-tenure">Sep 2026 – Present · 3 mos</mark></span><span class="li-when">Austin, Texas · On-site</span></div></div>
        <div class="li-job"><i class="li-co li-co--prev">B</i><div><b>Director of Operations</b><span>Brightline Freight · Full-time</span><span class="li-when">Jun 2021 – Aug 2026 · 5 yrs 3 mos</span></div></div>
      </section>
    </main>
    <aside class="li-side">
      <section class="li-card li-also">
        <h6>People also viewed</h6>
        ${peer(PEOPLE.marcus, "Marcus Bell", "COO at Fieldstone Logistics")}
        ${peer(PEOPLE.nadia, "Nadia Aziz", "Head of People at Acme Corp")}
        ${peer(PEOPLE.tomas, "Tomás Vega", "Ops Director at Northwind")}
      </section>
    </aside>
  </div>
</div>`,
};
