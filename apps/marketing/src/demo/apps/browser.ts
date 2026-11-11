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

/** A Chrome window. The first tab starts in front; a scene switches tabs with `front(<tab id>)`. */
export function browser(place: string, tabs: readonly BrowserTab[], open = true): string {
  const on = (index: number): string => (index === 0 ? " is-on" : "");
  return `<div class="win br${open ? " is-open is-front" : ""}" data-win="browser" style="${place}">
  <div class="br-strip">${TRAFFIC_LIGHTS}${tabs
    .map(
      (tab, index) =>
        `<div class="br-tab${on(index)}" data-for="${tab.id}">${tab.mark}<span>${tab.title}</span>${use("i-xmark")}</div>`,
    )
    .join("")}<span class="br-new">${use("m-plus")}</span></div>
  <div class="br-bar">${use("m-chevl")}${use("m-chevr")}<svg class="br-reload" viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="br-omni">${use("i-lock")}${tabs
    .map((tab, index) => `<span class="br-url${on(index)}" data-for="${tab.id}">${tab.url}</span>`)
    .join("")}</div><span class="br-me">AR</span></div>
  <div class="br-pages">${tabs
    .map((tab, index) => `<div class="br-page${on(index)}" data-win="${tab.id}">${tab.page}</div>`)
    .join("")}</div>
</div>`;
}
