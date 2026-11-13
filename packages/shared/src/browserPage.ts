/**
 * The skin of every page a server renders for a browser outside the app: the
 * Account's sign-in and consent moments, the portal's list of Opensteers, and
 * the "you can close this tab" pages a provider sign-in ends on.
 *
 * These pages are the app's front doors, so they wear the app's own material
 * (apps/web/src/styles/tokens.css): near-black ground, ember accent, surfaces
 * lit from their top edge rather than by shadows, Inter for words and Fraunces
 * for titles. The values are restated here because the pages cannot load the
 * app's stylesheet; a change to the app's palette or materials belongs in both.
 *
 * One document, one paint: the stylesheet is inline and the only other request
 * is the two fonts, which a server opts into by serving them (`fonts`). Without
 * them the pages fall back to the platform's own sans and serif.
 */

export type BrowserPageLayout = "app" | "card" | "plain";

/** Same-origin URLs of the latin `wght` axis of Inter and Fraunces. */
export interface BrowserPageFonts {
  readonly display: string;
  readonly sans: string;
}

export interface BrowserPage {
  /** Fully composed, already escaped body markup. */
  readonly body: string;
  readonly fonts?: BrowserPageFonts;
  /**
   * `card` is an authentication moment: one lit card in the middle of the
   * page. `plain` is an outcome: a mark and a sentence, no card. `app` is the
   * signed-in page with a masthead.
   */
  readonly layout: BrowserPageLayout;
  /** An origin the page's one action is about to need, warmed up early. */
  readonly preconnect?: string;
  readonly title: string;
}

const htmlEscapes: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "&": "&amp;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(value: string): string {
  return value.replace(/["&'<>]/gu, (character) => htmlEscapes[character] ?? character);
}

export function renderBrowserPage(page: BrowserPage): string {
  const fonts = page.fonts
    ? `<link rel="preload" href="${escapeHtml(page.fonts.sans)}" as="font" type="font/woff2" crossorigin><link rel="preload" href="${escapeHtml(page.fonts.display)}" as="font" type="font/woff2" crossorigin><style>${fontFaces(page.fonts)}</style>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#080808">
<title>${escapeHtml(page.title)}</title>${page.preconnect ? `<link rel="preconnect" href="${escapeHtml(page.preconnect)}">` : ""}${fonts}<style>${pageStyles}</style></head>
<body class="layout-${page.layout}">${page.body}</body></html>`;
}

/**
 * `optional`: on a fast link the preloaded font is in place for the first
 * paint; on a slow one the page paints in the platform font and stays that way
 * instead of reflowing when the font lands. Either way nothing waits on it,
 * and the next page has it from cache.
 */
function fontFaces(fonts: BrowserPageFonts): string {
  const face = (family: string, url: string) =>
    `@font-face{font-family:"${family}";font-style:normal;font-display:optional;font-weight:100 900;src:url("${url.replaceAll('"', "%22")}") format("woff2-variations"),url("${url.replaceAll('"', "%22")}") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`;
  return `${face("Inter Variable", fonts.sans)}${face("Fraunces Variable", fonts.display)}`;
}

/* ---- Primitives ----
   Each returns finished markup. Arguments that carry a person's words are
   escaped here; markup arguments are the caller's and already safe. */

export type BrowserPageIcon =
  | "alert"
  | "check"
  | "chevron"
  | "clock"
  | "download"
  | "key"
  | "laptop"
  | "link"
  | "lock"
  | "more"
  | "person"
  | "plus"
  | "server"
  | "shield"
  | "signOut"
  | "stack"
  | "trash";

const iconPaths: Readonly<Record<BrowserPageIcon, string>> = {
  alert: '<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="8.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  key: '<circle cx="8" cy="14" r="3.5"/><path d="M10.5 11.5 18 4M15 7l2.5 2.5M17.5 4.5 20 7"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5"/>',
  plus: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
  server:
    '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/>',
  signOut: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  stack: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16l8 4 8-4"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
};

export function icon(name: BrowserPageIcon, className?: string): string {
  return `<svg class="icon${className ? ` ${className}` : ""}" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]}</svg>`;
}

/** Google's own mark, in its own colours, as its sign-in guidance asks. */
export function googleMark(): string {
  return `<svg class="icon icon--brand" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
}

/** Apple's mark, inheriting the button's single colour as its sign-in guidance asks. */
export function appleMark(): string {
  return `<svg class="icon icon--brand" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`;
}

/** The product orb, drawn in CSS so no image loads. */
export function brandMark(size: "large" | "small" = "large"): string {
  return `<span class="orb orb--${size}" aria-hidden="true"></span>`;
}

export function brandLockup(href = "/"): string {
  return `<a class="lockup" href="${escapeHtml(href)}">${brandMark("small")}<span>opensteer</span></a>`;
}

/** A person's initial in a lit disc: the Account, wherever it is drawn. */
export function avatar(label: string, size: "large" | "small" = "small"): string {
  const initial = [...label.trim()][0]?.toLocaleUpperCase() ?? "?";
  return `<span class="avatar avatar--${size}" aria-hidden="true">${escapeHtml(initial)}</span>`;
}

/**
 * Two things and how they are joined: this computer and the Account, an app
 * and the person it asks. Each end may carry a caption under it. The wire is
 * dashed until an enclosing `data-state="linked"` makes it solid, when the
 * knot trades its mark for a check.
 */
export function bridge(input: {
  readonly from: string;
  readonly fromCaption?: string;
  readonly knot: BrowserPageIcon;
  readonly to: string;
  readonly toCaption?: string;
}): string {
  const end = (mark: string, caption: string | undefined) =>
    `<span class="bridge__end">${mark}${caption ? `<span class="bridge__caption">${escapeHtml(caption)}</span>` : ""}</span>`;
  return `<div class="bridge">${end(input.from, input.fromCaption)}<span class="bridge__wire"><span class="bridge__knot">${icon(input.knot)}${icon("check", "icon--joined")}</span></span>${end(input.to, input.toCaption)}</div>`;
}

export type BrowserPageTone = "busy" | "ok" | "warn";

/** A large ringed mark that says how something ended before any words do. */
export function statusMark(tone: BrowserPageTone, mark: BrowserPageIcon): string {
  return `<span class="status-mark status-mark--${tone}" aria-hidden="true">${icon(mark)}</span>`;
}

/**
 * An outcome on its own page: a ringed mark, a title, at most one sentence and
 * at most one way onward.
 */
export function statusPageBody(input: {
  readonly action?: { readonly href: string; readonly label: string };
  readonly detail?: string;
  readonly mark: BrowserPageIcon;
  readonly title: string;
  readonly tone: BrowserPageTone;
}): string {
  return `<main class="outcome">${statusMark(input.tone, input.mark)}<h1 class="title">${escapeHtml(input.title)}</h1>${
    input.detail ? `<p class="lead">${escapeHtml(input.detail)}</p>` : ""
  }${input.action ? `<a class="btn" href="${escapeHtml(input.action.href)}">${escapeHtml(input.action.label)}</a>` : ""}</main>`;
}

/* ---- Stylesheet ----
   Scales and materials mirror apps/web/src/styles/tokens.css. Controls are a
   step larger than the app's dense 30px because these pages hold one or two
   actions each, and reach 44px wherever a finger can. */
const pageStyles = `
*,*::before,*::after{box-sizing:border-box}
:root{
color-scheme:dark;
--bg:#080808;--text:#f5f4f2;--text-soft:#cecbc7;--muted:#8e8a86;--muted-dim:#898581;
--ember:#e6beb0;--ember-bright:#f1cabe;--ink-on-ember:#1b120e;
--green:#71c6a5;--amber:#dfb36b;--red:#e77e76;
--light:255 255 255;
--sheen:linear-gradient(rgb(var(--light) / 3.5%),rgb(var(--light) / 0%));
--sheen-accent:linear-gradient(rgb(255 255 255 / 16%),rgb(255 255 255 / 0%));
--sheen-mark:linear-gradient(rgb(255 255 255 / 18%),rgb(255 255 255 / 0%) 70%);
--fill-quiet:rgb(var(--light) / 5%);--fill-plate:rgb(var(--light) / 5%);--fill-plate-hover:rgb(var(--light) / 8%);
--surface-elevated:#171717;--fill-float:var(--surface-elevated);
--rim-plate:rgb(var(--light) / 7%);--rim-float:rgb(var(--light) / 9%);--rim-quiet:rgb(var(--light) / 6%);
--rim-accent:color-mix(in srgb,var(--ember),var(--ink-on-ember) 24%);
--edge-plate:inset 0 1px 0 rgb(var(--light) / 7%);--edge-accent:inset 0 1px 0 rgb(255 255 255 / 50%);
--edge-mark:inset 0 1px 0 rgb(255 255 255 / 24%),inset 0 0 0 1px rgb(0 0 0 / 22%);
--lift-float:0 12px 32px -16px rgb(0 0 0 / 60%);
--divider:rgb(var(--light) / 6%);
--cutout:color-mix(in srgb,var(--bg),rgb(var(--light)) 6%);
--radius-xs:6px;--radius-sm:8px;--radius-md:12px;--radius-lg:16px;--radius-full:999px;
--control:36px;
--gutter:clamp(16px,5vw,28px);
--font-sans:"Inter Variable",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",ui-sans-serif,sans-serif;
--font-display:"Fraunces Variable",Fraunces,ui-serif,"New York",Georgia,serif;
--font-mono:ui-monospace,"SF Mono","Cascadia Code","Segoe UI Mono",Menlo,monospace;
--ease-out:cubic-bezier(0.22,1,0.36,1);--fast:130ms;--slow:380ms
}
@media (any-pointer:coarse){:root{--control:44px}}
@media (prefers-contrast:more){:root{--rim-plate:rgb(var(--light) / 22%);--rim-quiet:rgb(var(--light) / 22%);--rim-float:rgb(var(--light) / 30%);--edge-plate:inset 0 1px 0 rgb(var(--light) / 14%);--muted:#b3afab}}
html{-webkit-text-size-adjust:100%;background:var(--bg)}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;
background:var(--bg) radial-gradient(100% 50% at 50% -14%,rgb(230 190 176 / 6%),transparent 62%) no-repeat;
color:var(--text);font:400 15px/1.5 var(--font-sans);
-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;
overflow-wrap:anywhere;-webkit-tap-highlight-color:transparent}
h1,h2,p,ul{margin:0}
ul{padding:0;list-style:none}
a{color:var(--ember);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
form{margin:0}
[hidden]{display:none!important}
:focus-visible{outline:2px solid var(--ember);outline-offset:2px}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}

/* Layouts */
.layout-card,.layout-plain{align-items:center;justify-content:center;
padding:calc(clamp(20px,6vh,48px) + env(safe-area-inset-top,0px)) calc(var(--gutter) + env(safe-area-inset-right,0px)) calc(clamp(20px,6vh,48px) + env(safe-area-inset-bottom,0px)) calc(var(--gutter) + env(safe-area-inset-left,0px))}
.card{position:relative;width:min(100%,25rem);display:flex;flex-direction:column;gap:18px;
padding:clamp(24px,6vw,32px) clamp(18px,5vw,28px) clamp(20px,5vw,24px);
border:1px solid var(--rim-plate);border-radius:var(--radius-lg);background:var(--sheen) var(--fill-plate);box-shadow:var(--edge-plate);
animation:rise-in var(--slow) var(--ease-out)}
/* The ember hairline the signed-in shell carries, at the moment there is no shell. */
.card::before{content:"";position:absolute;top:-1px;left:14%;right:14%;height:1px;
background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--ember) 22%,transparent),transparent)}
.card__head{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.outcome{width:min(100%,24rem);display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;animation:rise-in var(--slow) var(--ease-out)}
.outcome .btn{margin-top:6px;min-width:9rem}

/* Type */
.title{font-family:var(--font-display);font-weight:520;font-size:clamp(23px,6.2vw,27px);line-height:1.2;letter-spacing:-.025em;text-wrap:balance}
.title--page{font-size:clamp(25px,3.6vw + 12px,32px)}
.lead{color:var(--muted);font-size:13.5px;line-height:1.55;text-wrap:pretty}
.fine{color:var(--muted);font-size:12px;line-height:1.5;text-align:center;text-wrap:pretty}
.mono{font-family:var(--font-mono);font-size:11.5px}

/* Marks */
.icon{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.icon--brand{stroke:none}
.orb{display:block;flex:none;border-radius:50%;background:linear-gradient(#d9d9d9,#e8c4b4);box-shadow:inset 0 1px 0 rgb(255 255 255 / 60%)}
.orb--small{width:18px;height:18px}
.orb--large{width:44px;height:44px;box-shadow:0 6px 24px -8px rgb(230 190 176 / 40%),inset 0 1px 0 rgb(255 255 255 / 60%)}
.avatar{display:grid;place-items:center;flex:none;border-radius:50%;
background:var(--sheen-mark) color-mix(in srgb,var(--ember) 42%,#3b2a24);box-shadow:var(--edge-mark);
color:#fff;font-weight:650;letter-spacing:-.02em;line-height:1}
.avatar--small{width:28px;height:28px;font-size:12.5px}
.avatar--large{width:48px;height:48px;font-size:19px}
/* A thing a person owns, drawn: a computer, a server, an app. */
.device{position:relative;display:grid;place-items:center;flex:none;width:40px;height:40px;
border:1px solid var(--rim-plate);border-radius:10px;background:var(--sheen) rgb(var(--light) / 6%);box-shadow:var(--edge-plate);color:var(--text-soft)}
.device .icon{width:21px;height:21px}
.device--large{width:48px;height:48px;border-radius:12px}
.device--large .icon{width:24px;height:24px}
.device--app{background:var(--sheen-mark) #222;box-shadow:var(--edge-mark);border-color:transparent}
.device--app .orb{width:24px;height:24px}
.dot{position:absolute;right:-3px;bottom:-3px;width:11px;height:11px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 2.5px var(--cutout)}
.dot--ok{background:var(--green)}
.dot--busy,.dot--warn{background:var(--amber)}
.dot--busy{animation:pulse 1.6s var(--ease-out) infinite}
.dot--muted{background:#55524f}
.status-mark{display:grid;place-items:center;width:56px;height:56px;border-radius:50%}
.status-mark .icon{width:26px;height:26px;stroke-width:1.8}
.status-mark--ok{color:var(--green);background:color-mix(in srgb,var(--green) 10%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--green) 30%,transparent),inset 0 1px 0 rgb(var(--light) / 10%)}
.status-mark--warn{color:var(--amber);background:color-mix(in srgb,var(--amber) 8%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--amber) 30%,transparent),inset 0 1px 0 rgb(var(--light) / 10%)}
.status-mark--busy{color:var(--ember);background:color-mix(in srgb,var(--ember) 8%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ember) 22%,transparent)}
.spinner{display:block;width:16px;height:16px;flex:none;border-radius:50%;border:2px solid rgb(var(--light) / 18%);border-top-color:var(--ember);animation:spin .8s linear infinite}

/* Bridge: two things and the line between them */
.bridge{display:flex;align-items:flex-start;justify-content:center;width:100%}
.bridge__end{display:flex;flex-direction:column;align-items:center;gap:8px;flex:0 1 7.5rem;min-width:0}
.bridge__end > :first-child{flex:none}
.bridge__caption{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11.5px;line-height:1.3}
.bridge__wire{position:relative;flex:0 0 clamp(40px,14vw,64px);height:2px;margin-top:23px;
background:repeating-linear-gradient(90deg,rgb(var(--light) / 24%) 0 4px,transparent 4px 8px);
transition:background-color var(--fast) var(--ease-out)}
.bridge__knot{position:absolute;left:50%;top:50%;display:grid;place-items:center;width:26px;height:26px;transform:translate(-50%,-50%);
border:1px solid var(--rim-float);border-radius:50%;background:#141414;color:var(--muted);
transition:background-color var(--slow) var(--ease-out),color var(--slow) var(--ease-out),transform var(--slow) var(--ease-out)}
.bridge__knot .icon{width:13px;height:13px;stroke-width:2}
.bridge__knot .icon--joined,[data-state="linked"] .bridge__knot .icon{display:none}
[data-state="linked"] .bridge__knot .icon--joined{display:block;stroke-width:2.4}
[data-state="linking"] .bridge__wire{background:repeating-linear-gradient(90deg,rgb(var(--light) / 40%) 0 4px,transparent 4px 8px) 0 0 / 16px 2px;animation:flow .6s linear infinite}
[data-state="linked"] .bridge__wire{background:var(--green)}
[data-state="linked"] .bridge__knot{border-color:transparent;background:var(--green);color:#0b2219;transform:translate(-50%,-50%) scale(1.08)}
[data-state="failed"] .bridge__knot{color:var(--amber)}

/* Controls */
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--control);padding:0 16px;
border:1px solid var(--rim-plate);border-radius:var(--radius-sm);background:var(--sheen) var(--fill-plate);box-shadow:var(--edge-plate);
color:var(--text);font:520 13.5px/1.2 var(--font-sans);text-decoration:none;white-space:nowrap;cursor:pointer;user-select:none;
transition:background-color var(--fast) var(--ease-out),transform var(--fast) var(--ease-out),opacity var(--fast) var(--ease-out)}
.btn:hover{background-color:var(--fill-plate-hover);text-decoration:none}
.btn:active:not(:disabled){box-shadow:none;transform:scale(.97)}
.btn:disabled{opacity:.45;cursor:default}
.btn--primary{border-color:var(--rim-accent);background:var(--sheen-accent) var(--ember);box-shadow:var(--edge-accent);color:var(--ink-on-ember);font-weight:600}
.btn--primary:hover{background-color:var(--ember-bright)}
.btn--danger{color:var(--red)}
.btn--danger:hover{background-color:color-mix(in srgb,var(--red) 9%,transparent)}
.btn--block{display:flex;width:100%}
.btn--apple{border-color:#fff;background:#fff;box-shadow:none;color:#000}
.btn--apple:hover{background-color:#e8e8e8}
.sign-in-options{display:grid;gap:10px}
.btn .icon{width:17px;height:17px}
.btn .spinner{position:absolute;left:14px;width:14px;height:14px}
.btn--primary .spinner{border-color:rgb(27 18 14 / 22%);border-top-color:var(--ink-on-ember)}
.actions{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:8px}
.icon-btn{display:grid;place-items:center;flex:none;width:var(--control);height:var(--control);padding:0;
border:0;border-radius:var(--radius-sm);background:transparent;color:var(--muted);cursor:pointer;
transition:background-color var(--fast) var(--ease-out),color var(--fast) var(--ease-out)}
.icon-btn:hover{background:var(--fill-quiet);color:var(--text)}
.icon-btn .icon{stroke-width:3}
.form{display:grid;gap:14px}
.field{display:flex;align-items:center;min-height:var(--control);border:1px solid var(--rim-plate);border-radius:var(--radius-sm);background:var(--fill-quiet)}
.field:focus-within{outline:2px solid var(--ember);outline-offset:2px}
.field input{flex:1;width:0;min-width:0;height:var(--control);padding:0 2px 0 12px;border:0;background:transparent;color:var(--text);font:inherit;outline:none}
.field__suffix{padding-right:12px;color:var(--muted);white-space:nowrap}
.steps{display:grid;gap:10px;list-style:none;padding:0;margin:0}
.step{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13.5px;line-height:1.4}
.step::before{content:"";flex:none;width:8px;height:8px;margin:0 4px;border-radius:50%;background:rgb(var(--light) / 18%)}
.step[data-state="active"]{color:var(--text)}
.step[data-state="active"]::before{background:var(--ember);animation:pulse 1.6s var(--ease-out) infinite}
.step[data-state="done"]{color:var(--text-soft)}
.step[data-state="done"]::before{background:var(--green)}
.section-title{color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.02em}

/* Masthead */
.masthead{display:flex;align-items:center;justify-content:space-between;gap:12px;
padding:calc(12px + env(safe-area-inset-top,0px)) calc(var(--gutter) + env(safe-area-inset-right,0px)) 12px calc(var(--gutter) + env(safe-area-inset-left,0px))}
.lockup{display:inline-flex;align-items:center;gap:8px;min-height:var(--control);color:var(--text);font-weight:600;font-size:13.5px;letter-spacing:-.025em}
.lockup:hover{text-decoration:none}
.account-btn{display:grid;place-items:center;width:var(--control);height:var(--control);padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer;anchor-name:--account}
.account-btn:active .avatar{transform:scale(.94)}
.account-btn .avatar{transition:transform var(--fast) var(--ease-out)}
.column{width:100%;max-width:calc(30rem + 2 * var(--gutter));margin:0 auto;display:flex;flex-direction:column;gap:18px;
padding:clamp(8px,4vh,28px) calc(var(--gutter) + env(safe-area-inset-right,0px)) calc(40px + env(safe-area-inset-bottom,0px)) calc(var(--gutter) + env(safe-area-inset-left,0px));
animation:rise-in var(--slow) var(--ease-out)}

/* Places: one row per Opensteer */
.places{display:flex;flex-direction:column;gap:8px}
.place{position:relative;display:flex;align-items:center;gap:13px;min-height:64px;padding:11px 8px 11px 11px;
border:1px solid var(--rim-plate);border-radius:var(--radius-md);background:var(--sheen) var(--fill-plate);box-shadow:var(--edge-plate);
transition:background-color var(--fast) var(--ease-out),transform var(--fast) var(--ease-out)}
.place__body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.place__name{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
padding:0;border:0;background:none;color:var(--text);font:600 14px/1.35 var(--font-sans);letter-spacing:-.01em;text-align:left;cursor:pointer}
.place__name:hover{text-decoration:none}
/* The name is the one control; its hit area is the whole row. */
.place__name::after{content:"";position:absolute;inset:0;border-radius:inherit}
.place__name:focus-visible{outline:none}
.place:has(.place__name:focus-visible){outline:2px solid var(--ember);outline-offset:2px}
.place__note{color:var(--muted);font-size:12px;line-height:1.4;text-wrap:pretty}
.place__note--warn{color:color-mix(in srgb,var(--amber) 70%,var(--text))}
.place__go{flex:none;display:grid;place-items:center;width:24px;color:var(--muted-dim);transition:color var(--fast) var(--ease-out),transform var(--fast) var(--ease-out)}
.place__go .icon{width:16px;height:16px}
.place__menu{position:relative;z-index:1}
@media (hover:hover){
.place--open:hover{background-color:var(--fill-plate-hover)}
.place--open:hover .place__go{color:var(--text-soft);transform:translateX(2px)}
.place--open:hover .dot{box-shadow:0 0 0 2.5px color-mix(in srgb,var(--bg),rgb(var(--light)) 9%)}
}
.place--open:active{transform:scale(.985)}
.place--still{background:transparent;box-shadow:none;border-color:var(--rim-quiet)}
.place--still .device .icon,.place--still .place__name{opacity:.6}
.place--still .dot{box-shadow:0 0 0 2.5px var(--bg)}
.place--still .place__name{cursor:default}
.place--add{background:transparent;box-shadow:none;border:1px dashed rgb(var(--light) / 13%)}
.place--add .device{background:transparent;box-shadow:none;border-style:dashed;color:var(--ember)}
.place--add .place__name{color:var(--text-soft)}
.place--add:hover{background-color:var(--fill-quiet)}
.empty{display:flex;flex-direction:column;align-items:center;gap:16px;padding:clamp(24px,8vh,56px) 0;text-align:center}
.empty .device{width:64px;height:64px;border-radius:16px}
.empty .device .icon{width:30px;height:30px}
.empty .btn{min-width:12rem}

/* Floats: menus and confirmations, native popovers */
[popover]{margin:0;padding:0;border:1px solid var(--rim-float);background:var(--sheen) var(--fill-float);box-shadow:var(--edge-plate),var(--lift-float);color:var(--text)}
.menu{position:fixed;inset:auto;top:calc(56px + env(safe-area-inset-top,0px));right:calc(var(--gutter) + env(safe-area-inset-right,0px));
width:min(16rem,calc(100vw - 2 * var(--gutter)));padding:5px;border-radius:var(--radius-md)}
@supports (position-anchor:--account){
.menu{position-anchor:--account;top:calc(anchor(bottom) + 6px);right:anchor(right)}
}
.menu__who{display:flex;align-items:center;gap:10px;padding:8px 8px 10px;margin-bottom:4px;border-bottom:1px solid var(--divider)}
.menu__who > span:last-child{min-width:0;display:flex;flex-direction:column}
.menu__who strong{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu__who small{color:var(--muted);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu__item{display:flex;align-items:center;gap:10px;width:100%;min-height:calc(var(--control) - 4px);padding:0 8px;
border:0;border-radius:7px;background:transparent;color:var(--text-soft);font:500 13px var(--font-sans);text-align:left;cursor:pointer}
.menu__item:hover{background:var(--fill-quiet);color:var(--text);text-decoration:none}
.menu__item .icon{width:16px;height:16px;color:var(--muted)}
.sheet{position:fixed;inset:0;margin:auto;width:min(22rem,calc(100vw - 2 * var(--gutter)));height:fit-content;
padding:22px 20px 18px;border-radius:var(--radius-lg);text-align:center}
.sheet::backdrop{background:rgb(0 0 0 / 58%)}
.sheet .title{font-size:21px}
.sheet .lead{margin:8px 0 18px}
@media (max-width:30rem){
.sheet{inset:auto 0 0;margin:0 auto;width:100%;border-radius:var(--radius-lg) var(--radius-lg) 0 0;border-bottom:0;
padding-bottom:calc(18px + env(safe-area-inset-bottom,0px))}
}
[popover]:popover-open{animation:pop-in var(--fast) var(--ease-out)}
/* Where the popover API is missing, its triggers go and a plain control stands in. */
.fallback-only{display:none!important}
@supports not selector(:popover-open){[popover],.needs-popover{display:none}.fallback-only{display:flex!important;justify-content:center}}

/* Permissions: what an app may do, one line each */
.grants{display:flex;flex-direction:column;border:1px solid var(--rim-plate);border-radius:var(--radius-md);background:var(--sheen) var(--fill-plate);box-shadow:var(--edge-plate)}
.grant{display:flex;align-items:center;gap:11px;padding:10px 12px;color:var(--text-soft);font-size:13px;line-height:1.4;text-align:left}
.grant + .grant{border-top:1px solid var(--divider)}
.grant .icon{width:16px;height:16px;color:var(--ember)}
.grant input{flex:none;width:16px;height:16px;margin:0;accent-color:var(--ember)}
.grant__who{display:flex;flex-direction:column;min-width:0}
.grant > a{flex:none;white-space:nowrap}
.grant__detail{min-width:0;margin-left:auto;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grants > li + li > .grant{border-top:1px solid var(--divider)}
.grant__who .grant__detail{margin-left:0}
label.grant{cursor:pointer;min-height:var(--control)}
.alert{display:grid;gap:10px;padding:14px;border:1px solid color-mix(in srgb,var(--amber) 32%,transparent);border-radius:var(--radius-md);
background:color-mix(in srgb,var(--amber) 6%,transparent);text-align:left}
.alert__title{color:var(--text);font-size:14px;font-weight:600;line-height:1.4}
.place:target{outline:2px solid var(--amber);outline-offset:2px}
.grant--danger .icon{color:var(--red)}
.chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 10px;border-radius:var(--radius-full);
background:var(--fill-quiet);color:var(--muted);font:11.5px/1.4 var(--font-mono)}
.chip > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip .icon{width:12px;height:12px}

@keyframes rise-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes pop-in{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes flow{to{background-position:16px 0}}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}
.spinner{animation:spin 1.6s linear infinite!important}
}
@media (forced-colors:active){.place__name::after{border:1px solid CanvasText}.dot,.orb,.avatar{forced-color-adjust:none}}
`;
