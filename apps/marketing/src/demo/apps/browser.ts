import "./browser.css";

export interface BrowserTab {
  /** The page's `data-win`, which a scene passes to `front`. */
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** Favicon markup. */
  readonly mark: string;
  readonly page: string;
}

const TRAFFIC_LIGHTS = `<span class="tl"><i></i><i></i><i></i></span>`;
const use = (id: string): string => `<svg><use href="#${id}"/></svg>`;
const glyph = (d: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const BACK = glyph("M13 8H3.5M7.5 4 3.5 8l4 4");
const FORWARD = glyph("M3 8h9.5M8.5 4l4 4-4 4");
const RELOAD = glyph("M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3");
const SITE = glyph("M3 5.5h5M11 5.5h2M3 10.5h2M8 10.5h5M9.5 4v3M6.5 9v3");
const STAR = glyph("m8 2.3 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.5l-3.6 1.9.7-4L2.2 6.6l4-.6Z");
const MORE = `<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.5" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="12.5" r="1.2"/></svg>`;

/** A Chrome window. The first tab starts in front; a scene switches tabs with `front(<tab id>)`. */
export function browser(place: string, tabs: readonly BrowserTab[]): string {
  const on = (index: number): string => (index === 0 ? " is-on" : "");
  return `<div class="win br is-open is-front" data-win="browser" style="${place}">
  <div class="br-strip">${TRAFFIC_LIGHTS}${tabs
    .map(
      (tab, index) =>
        `<div class="br-tab${on(index)}" data-for="${tab.id}">${tab.mark}<span>${tab.title}</span>${use("i-xmark")}</div>`,
    )
    .join("")}<span class="br-new">${use("m-plus")}</span></div>
  <div class="br-bar">${BACK}${FORWARD}<span data-h="br-reload">${RELOAD}</span><div class="br-omni">${SITE}${tabs
    .map((tab, index) => `<span class="br-url${on(index)}" data-for="${tab.id}">${tab.url}</span>`)
    .join("")}${STAR}</div><span class="br-me">AR</span>${MORE}</div>
  <div class="br-pages">${tabs
    .map((tab, index) => `<div class="br-page${on(index)}" data-win="${tab.id}">${tab.page}</div>`)
    .join("")}</div>
</div>`;
}
