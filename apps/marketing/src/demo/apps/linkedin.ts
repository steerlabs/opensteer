import "./linkedin.css";
import type { BrowserTab } from "./browser.js";

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
  <nav class="li-icons">${NAV.map(([name, path], index) => `<span${index === 4 ? ' class="li-dot"' : ""}>${glyph(path)}<b>${name}</b></span>`).join("")}<span class="li-me"><i>AR</i><b>Me ▾</b></span></nav>
</header>`;

const PORTRAIT = `<svg viewBox="0 0 120 120" aria-hidden="true"><rect width="120" height="120" fill="#c8d8e4"/><path d="M33 58c-4-26 10-41 27-41s32 14 27 41c-2 12 2 22 6 30H27c4-8 8-18 6-30Z" fill="#2a1c17"/><path d="M14 120c3-22 22-31 46-31s43 9 46 31Z" fill="#2f5d62"/><path d="M51 76h18v17c-3 4-15 4-18 0Z" fill="#a8704f"/><ellipse cx="60" cy="57" rx="19" ry="23" fill="#bb7f5b"/><path d="M40 52c4-15 13-21 24-21 8 0 15 5 17 15-11-1-21-5-27-11-3 7-8 13-14 17Z" fill="#2a1c17"/></svg>`;

const face = (initials: string, color: string): string =>
  `<i class="li-face" style="background:${color}">${initials}</i>`;

const peer = (initials: string, color: string, name: string, role: string): string =>
  `<div class="li-peer">${face(initials, color)}<div><b>${name}</b><span>${role}</span><em class="li-btn">Connect</em></div></div>`;

export const linkedin: BrowserTab = {
  id: "linkedin",
  title: "Priya Raman | LinkedIn",
  url: "www.linkedin.com<em>/in/priya-raman/</em>",
  mark: `<i class="br-fav" style="background:#0a66c2">in</i>`,
  page: `<div class="li">${TOP_NAV}
  <div class="li-body">
    <main class="li-main">
      <section class="li-card li-top">
        <div class="li-cover"></div>
        <div class="li-photo">${PORTRAIT}</div>
        <div class="li-intro">
          <div class="li-who">
            <h4>Priya Raman <span>· 1st</span></h4>
            <p class="li-headline" data-h="li-headline">VP Operations at Acme Corp | Building ops teams that scale</p>
            <p class="li-meta">Austin, Texas, United States · <a>Contact info</a></p>
            <p class="li-meta"><a>500+ connections</a></p>
          </div>
          <ul class="li-orgs"><li><i class="li-co">A</i>Acme Corp</li><li><i class="li-co li-co--edu">UT</i>UT Austin</li></ul>
        </div>
        <p class="li-mutual"><span class="li-faces">${face("JL", "#7a5c99")}${face("SO", "#c0723f")}</span>Jordan Lee, Sam Okafor and 4 other mutual connections</p>
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
          <p class="li-post__text">Three months in at Acme, and our ops team just reached <mark data-h="li-team">120 people</mark>. <mark class="li-mark--late" data-h="li-onboard">What made it work was onboarding: every new hire ships something real in week one, with a buddy beside them.</mark></p>
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
        ${peer("MB", "#4f7a5a", "Marcus Bell", "COO at Fieldstone Logistics")}
        ${peer("NA", "#8f5a6b", "Nadia Aziz", "Head of People at Acme Corp")}
        ${peer("TV", "#5b6fa6", "Tomás Vega", "Ops Director at Northwind")}
      </section>
    </aside>
  </div>
</div>`,
};
