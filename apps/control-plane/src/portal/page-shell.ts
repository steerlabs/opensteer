/**
 * The one skin both browser vhosts wear.
 *
 * The Account host and the apex portal are server-rendered, and their
 * Content-Security-Policy allows an inline stylesheet and nothing else — save
 * for the one nonced script a live page carries, which re-fetches that same
 * server-rendered page and swaps its live region in place. There is still only
 * one rendering path; the script never composes markup of its own. So the
 * design language of the product app (near-black ground,
 * warm ember accent, Fraunces display titles, Inter text, the shared
 * button/chip/panel primitives) is ported here as a single inline stylesheet
 * rather than linked assets. One document, one paint, no network waterfall:
 * that is the performance story, and it is why this file holds the CSS
 * literally instead of importing it.
 *
 * The product app is dark-only. These pages are public front doors, so the
 * palette is expressed twice: the product's own dark tokens, and a warm-paper
 * light counterpart with the ember deepened to a terracotta that clears WCAG AA
 * on light ground. Both directions are driven by `prefers-color-scheme`.
 */

import { escapeHtml } from "./browser-http.js";

/** Inline styles only, no scripts, no framing, no base rewriting. */
export const browserPageContentSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

/**
 * The still policy plus exactly what a live page needs: the one inline script
 * carrying this nonce, and same-origin fetches so it can re-read its own URL.
 * `'unsafe-inline'` is never granted to scripts here.
 */
export function liveBrowserPageContentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`;
}

/**
 * The element a live page swaps in place, and the script's only hook. The
 * region is marked `data-live` for exactly as long as the server considers the
 * page still moving, so the script reads one attribute and never status prose.
 */
export const liveRegionId = "live-region";

export interface BrowserPage {
  /** Fully composed body markup. Callers own their landmarks. */
  readonly body: string;
  /** `centered` is the auth-moment card; the default is the app layout. */
  readonly layout?: "app" | "centered";
  /**
   * Nonce of the in-place refresh script, matching the live policy above.
   * Present only while the body's live region is still marked `data-live`.
   */
  readonly liveScriptNonce?: string;
  readonly preconnect?: string;
  readonly title: string;
}

/** The gradient orb of the product wordmark, drawn in CSS so no asset loads. */
export function brandMark(options: { readonly large?: boolean } = {}): string {
  return `<span class="brand-mark${options.large ? " brand-mark--large" : ""}" aria-hidden="true"></span>`;
}

/** The product wordmark: orb plus lowercase word, exactly as the app shows it. */
export function brandLockup(): string {
  return `<span class="brand">${brandMark()}<span class="brand-word">opensteer</span></span>`;
}

export function renderBrowserPage(page: BrowserPage): string {
  const preconnect = page.preconnect
    ? `<link rel="preconnect" href="${escapeHtml(page.preconnect)}">`
    : "";
  const bodyClass = page.layout === "centered" ? ' class="centered"' : "";
  const live = page.liveScriptNonce
    ? `<script nonce="${escapeHtml(page.liveScriptNonce)}">${liveRegionScript}</script>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
${preconnect}<title>${escapeHtml(page.title)}</title><style>${pageStyles}</style></head>
<body${bodyClass}><div class="page">${page.body}</div>${live}</body></html>`;
}

/**
 * Re-reads this very URL and swaps the live region for the one the server just
 * rendered: same markup, same truth, no flash and no scroll reset. It stops the
 * moment the fresh region arrives without `data-live`. A non-OK answer (a 401
 * once the session lapses) hands over to one ordinary reload so the usual
 * sign-in redirect happens; a network blip just waits for the next tick.
 */
const liveRegionScript = `(function(){
var delay=2500,current=document.getElementById(${JSON.stringify(liveRegionId)});
if(!current)return;
function again(){window.setTimeout(poll,delay)}
function poll(){
fetch(location.href,{credentials:"same-origin",headers:{accept:"text/html"}}).then(function(response){
if(!response.ok){location.reload();return null}
return response.text()
}).then(function(html){
if(html===null)return;
var fresh=new DOMParser().parseFromString(html,"text/html").getElementById(${JSON.stringify(liveRegionId)});
if(!fresh){location.reload();return}
current.replaceWith(fresh);
current=fresh;
if(current.hasAttribute("data-live"))again()
}).catch(again)
}
again()
})()`;

const pageStyles = `
*,*::before,*::after{box-sizing:border-box}
:root{
color-scheme:light dark;
--bg:#faf8f6;--glow:rgb(154 74 40 / 7%);--surface:#fff;--sunken:#f2eeeb;
--text:#191512;--text-soft:#3d3833;--muted:#6b625c;
--line:rgb(25 21 18 / 12%);--line-strong:rgb(25 21 18 / 20%);
--accent:#9a4a28;--accent-hover:#7d3a1e;--accent-ink:#fff6f1;--accent-line:rgb(154 74 40 / 30%);--accent-wash:rgb(154 74 40 / 7%);
--ok:#186a45;--ok-line:rgb(24 106 69 / 34%);
--warn:#8a5a12;--warn-line:rgb(138 90 18 / 34%);
--danger:#a33c33;--danger-line:rgb(163 60 51 / 32%);--danger-wash:rgb(163 60 51 / 6%);
--shadow:0 1px 2px rgb(25 21 18 / 5%),0 12px 32px rgb(25 21 18 / 7%);
--mark-a:#cf8a63;--mark-b:#9a4a28;--mark-glow:rgb(154 74 40 / 30%);
--radius-xs:6px;--radius-sm:9px;--radius-md:12px;--radius-lg:16px;--radius-full:999px;
--font-sans:"Inter Variable",Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
--font-display:"Fraunces Variable",Fraunces,Georgia,"Times New Roman",serif;
--font-mono:ui-monospace,"SF Mono","Cascadia Code","Segoe UI Mono",Menlo,monospace;
--ease:cubic-bezier(.22,1,.36,1)
}
@media (prefers-color-scheme:dark){:root{
--bg:#080808;--glow:rgb(230 190 176 / 6%);--surface:#101010;--sunken:#242424;
--text:#f5f4f2;--text-soft:#cecbc7;--muted:#8e8a86;
--line:rgb(255 255 255 / 9%);--line-strong:rgb(255 255 255 / 15%);
--accent:#e6beb0;--accent-hover:#f1cabe;--accent-ink:#1b120e;--accent-line:rgb(230 190 176 / 24%);--accent-wash:rgb(230 190 176 / 9%);
--ok:#71c6a5;--ok-line:rgb(113 198 165 / 32%);
--warn:#dfb36b;--warn-line:rgb(223 179 107 / 34%);
--danger:#e77e76;--danger-line:rgb(231 126 118 / 36%);--danger-wash:rgb(231 126 118 / 9%);
--shadow:0 1px 2px rgb(0 0 0 / 40%),0 10px 30px rgb(0 0 0 / 34%);
--mark-a:#e4e0dd;--mark-b:#e9c5b5;--mark-glow:rgb(180 104 72 / 26%)
}}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;
padding:clamp(1.5rem,6vw,3.5rem) clamp(1rem,5vw,2rem) clamp(2.5rem,8vw,4.5rem);
background-color:var(--bg);
background-image:radial-gradient(120% 60% at 50% -12%,var(--glow),transparent 62%);
background-repeat:no-repeat;background-attachment:fixed;
color:var(--text);font-family:var(--font-sans);font-size:15px;line-height:1.55;
-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
text-rendering:optimizeLegibility;overflow-wrap:break-word}
.page{width:100%;max-width:46rem;margin-inline:auto;display:flex;flex-direction:column;gap:clamp(1.75rem,5vw,2.5rem)}
.centered .page{max-width:27rem;margin-block:auto;gap:1.25rem;align-items:flex-start;
padding:clamp(1.5rem,6vw,2.25rem);border:1px solid var(--line);border-radius:var(--radius-lg);
background:var(--surface);box-shadow:var(--shadow)}
main{display:flex;flex-direction:column;gap:clamp(1.5rem,4vw,2rem)}
.centered main{gap:1.25rem;width:100%}
h1,h2,p,ul{margin:0}
h1{font-family:var(--font-display);font-weight:550;letter-spacing:-.02em;line-height:1.14;
font-size:clamp(1.7rem,1.3rem + 2vw,2.3rem)}
.centered h1{font-size:clamp(1.45rem,1.2rem + 1.2vw,1.8rem)}
h2{font-size:15px;font-weight:600;letter-spacing:-.01em}
p{color:var(--text-soft)}
.lead{font-size:16px;color:var(--text-soft);max-width:36rem}
.fine{font-size:13px;color:var(--muted)}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.11em;text-transform:uppercase;color:var(--muted)}
.stack{display:flex;flex-direction:column;gap:.55rem;width:100%}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--radius-xs)}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
clip-path:inset(50%);white-space:nowrap;border:0}
.masthead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem 1rem}
.brand{display:inline-flex;align-items:center;gap:.5rem;min-width:0}
.brand-mark{width:18px;height:18px;flex:none;border-radius:var(--radius-full);
background:linear-gradient(162deg,var(--mark-a) 6%,var(--mark-b) 94%);
box-shadow:0 2px 9px var(--mark-glow),inset 0 1px 0 rgb(255 255 255 / 55%)}
.brand-mark--large{width:40px;height:40px;box-shadow:0 6px 22px var(--mark-glow),inset 0 1px 0 rgb(255 255 255 / 55%)}
.brand-word{font-size:13.5px;font-weight:600;letter-spacing:-.025em;color:var(--text)}
.session{display:flex;align-items:center;gap:.5rem;min-width:0}
.session-account{font-size:13px;color:var(--muted);max-width:min(22rem,52vw);
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The account string is already truncating, so it yields to the control beside
it rather than squeezing "Sign out" onto three lines on a narrow screen. */
.session .btn{white-space:nowrap}
form{margin:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;min-height:40px;
padding:.55rem 1.15rem;border:1px solid var(--line-strong);border-radius:var(--radius-sm);
background:var(--surface);color:var(--text);font:inherit;font-size:14px;font-weight:500;
line-height:1.2;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent;
transition:background-color .13s var(--ease),border-color .13s var(--ease),transform .13s var(--ease)}
.btn:hover{background:var(--sunken);text-decoration:none}
.btn:active{transform:scale(.985)}
.btn--primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.btn--primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn--quiet{min-height:34px;padding:.35rem .75rem;background:transparent;border-color:transparent;color:var(--muted)}
.btn--quiet:hover{background:var(--sunken);color:var(--text)}
.btn--wide{width:100%}
.actions{display:flex;flex-wrap:wrap;gap:.6rem;width:100%}
.actions .btn{flex:1 1 9rem}
.section{display:flex;flex-direction:column;gap:.85rem}
.section-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem .75rem}
.page-head{display:flex;flex-direction:column;gap:.35rem}
.deployments{list-style:none;padding:0;display:grid;gap:.7rem}
.deployment{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;
align-items:center;column-gap:.85rem;padding:.9rem 1.05rem;
border:1px solid var(--line);border-radius:var(--radius-md);background:var(--surface);
transition:border-color .13s var(--ease),box-shadow .13s var(--ease),transform .13s var(--ease)}
.deployment:not(.deployment--still):hover{border-color:var(--accent-line);box-shadow:var(--shadow);transform:translateY(-1px)}
.deployment--still{background:transparent}
.deployment--action{border-style:dashed}
@supports selector(:has(*)){
.deployment:has(.deployment-name:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.deployment-name:focus-visible{outline:none}
}
.deployment-mark{width:34px;height:34px;flex:none;display:grid;place-items:center;
border:1px solid var(--accent-line);border-radius:var(--radius-sm);
color:var(--accent);font-family:var(--font-display);font-size:16px;font-weight:550;line-height:1;
background:var(--accent-wash)}
.deployment--still .deployment-mark{border-color:var(--line-strong);color:var(--muted);background:transparent}
.deployment-copy{min-width:0;display:flex;flex-direction:column;gap:.1rem}
.deployment-copy form{margin:0}
.deployment-name{font-size:15px;font-weight:600;color:var(--text);letter-spacing:-.01em}
.deployment-copy .deployment-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deployment-copy form .deployment-name{appearance:none;width:100%;padding:0;border:0;background:transparent;
font:inherit;font-size:15px;font-weight:600;color:var(--text);text-align:left;cursor:pointer}
.deployment-name::after{content:"";position:absolute;inset:0;border-radius:inherit}
.deployment-name:hover{text-decoration:none}
.deployment-kind{min-width:0;font-size:12px;color:var(--muted);
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.deployment-note{min-width:0;font-size:12px;color:var(--muted);text-wrap:pretty}
.deployment-remove{position:relative;z-index:1;width:max-content}
.deployment-secondary{position:relative;z-index:1;width:max-content;font-size:12px}
.deployment-remove button{appearance:none;padding:0;border:0;background:transparent;color:var(--muted);
font:inherit;font-size:12px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.deployment-remove button:hover{color:var(--text)}
.deployment-go{width:7px;height:7px;margin-inline:.15rem .3rem;
border-top:1.5px solid;border-right:1.5px solid;transform:rotate(45deg);color:var(--muted);
transition:color .13s var(--ease)}
.deployment:hover .deployment-go{color:var(--accent)}
.chip{display:inline-flex;align-items:center;gap:.4rem;padding:.15rem .6rem;border-radius:var(--radius-full);
border:1px solid var(--line-strong);font-size:11.5px;font-weight:600;color:var(--text-soft);white-space:nowrap}
.chip-dot{width:6px;height:6px;flex:none;border-radius:var(--radius-full);background:currentColor}
.chip--ok{color:var(--ok);border-color:var(--ok-line)}
.chip--busy{color:var(--warn);border-color:var(--warn-line)}
.chip--busy .chip-dot{animation:pulse 1.7s ease-in-out infinite}
.chip--warn{color:var(--danger);border-color:var(--danger-line)}
.chip--muted{color:var(--muted);border-color:var(--line-strong)}
.permissions{list-style:none;padding:0;display:flex;flex-direction:column;gap:.55rem;width:100%}
.permissions li{position:relative;padding-left:1.4rem;font-size:14px;color:var(--text-soft)}
.permissions li::before{content:"";position:absolute;left:.3rem;top:.6em;width:6px;height:6px;
border-radius:var(--radius-full);background:var(--accent)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (max-width:26rem){
.deployment{grid-template-columns:auto minmax(0,1fr);padding:.9rem 1rem;row-gap:.35rem}
.deployment .chip{grid-column:2;justify-self:start}
.deployment-go{display:none}
.actions .btn{flex:1 1 100%}
.session-account{max-width:min(22rem,64vw)}
}
@media (prefers-reduced-motion:reduce){
*{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}
.progress::after{width:100%;opacity:.55}
}
`;
