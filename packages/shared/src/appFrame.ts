/** Kept identical on HTTP and Electron's isolated app scheme. */
export const appFrameScheme = "opensteer-app";
export const appFrameSandbox = "allow-scripts allow-popups";
export const appFrameContentSecurityPolicy = [
  `sandbox ${appFrameSandbox}`,
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "connect-src 'self'",
  "media-src 'self' https: data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** An app with a real origin is isolated by that origin, so its frame keeps it. */
export const appOriginFrameSandbox =
  "allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
export const appOriginTicketParameter = "opensteer-ticket";
/** Set by the Connect edge, where the Host only sees its own hostname. */
export const appOriginHeader = "x-opensteer-app-origin";

const appKeyAlphabet = "abcdefghijklmnopqrstuvwxyz234567";

/** An app's DNS label: base32 of its UUID, because the hex form leaves no room for a Deployment. */
export function appOriginKey(appId: string): string {
  const hex = appId.slice("app_".length).replaceAll("-", "");
  let key = "";
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < hex.length; index += 2) {
    buffer = (buffer << 8) | Number.parseInt(hex.slice(index, index + 2), 16);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      key += appKeyAlphabet[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return bits ? key + appKeyAlphabet[(buffer << (5 - bits)) & 31] : key;
}

/** Null unless the hostname is exactly one app's origin; an app never has two spellings. */
export function appIdFromHostname(hostname: string): string | null {
  const key = /^([a-z2-7]{26})(?:-[0-9a-f]{32})?\./u.exec(hostname)?.[1];
  if (!key) return null;
  let hex = "";
  let buffer = 0;
  let bits = 0;
  for (const character of key) {
    buffer = (buffer << 5) | appKeyAlphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((buffer >>> bits) & 255).toString(16).padStart(2, "0");
      buffer &= (1 << bits) - 1;
    }
  }
  const appId = `app_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return appOriginKey(appId) === key ? appId : null;
}

export function isAppOriginUrl(value: string): boolean {
  try {
    const { hostname, protocol } = new URL(value);
    if (appIdFromHostname(hostname) === null) return false;
    return protocol === "https:" || (protocol === "http:" && hostname.endsWith(".localhost"));
  } catch {
    return false;
  }
}

/**
 * Runs before an app's scripts. The gateway stores app cookies as `__Host-`, which a sibling
 * subdomain cannot plant, so scripts must keep seeing the names the app chose.
 */
const appOriginScript = `
  const entry=new URL(location.href);
  if(entry.searchParams.has('${appOriginTicketParameter}')){entry.searchParams.delete('${appOriginTicketParameter}');history.replaceState(history.state,'',entry)}
  const cookie=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
  Object.defineProperty(document,'cookie',{configurable:true,
    get(){return cookie.get.call(document).split('; ').filter(c=>c.startsWith('__Host-')).map(c=>c.slice(7)).join('; ')},
    set(value){const [pair,...attributes]=String(value).split(';');
      const lifetime=attributes.filter(a=>/^\\s*(expires|max-age)=/i.test(a)).map(a=>';'+a).join('');
      cookie.set.call(document,'__Host-'+pair.trim()+'; Path=/; Secure; SameSite=None; Partitioned'+lifetime)}});`;

export function appFrameHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": appFrameContentSecurityPolicy,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=()",
  };
}

export type AppTheme = "light" | "dark";
export function appThemeScript(theme: AppTheme): string {
  return `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};window.dispatchEvent(new CustomEvent('opensteer:theme',{detail:{theme:${JSON.stringify(theme)}}}));true;`;
}

// Android delivers WebView messages and navigation events through different
// paths. A post-load query can read the current document's readiness directly.
const appReadyFlag = "__opensteerAppFrameReady";
export const appFrameReadinessScript = `
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: window.${appReadyFlag} === true ? 'opensteer-app:ready' : 'opensteer-app:unprepared'
  }));
  true;
`;

export function prepareAppHtml(html: string, theme: AppTheme, realOrigin = false): string {
  const doctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/iu.exec(html);
  if (!doctype) html = "<!doctype html>" + html;
  const bootstrap = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script>
(()=>{${realOrigin ? appOriginScript : ""}
  ${appThemeScript(theme)}
  const send=message=>{
    if(parent!==window)parent.postMessage(message,'*');
    if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  const departure=${appDeparture.toString()};
  // Taken before the app's scripts run, so nothing the app redefines later changes what follows.
  const apply=Reflect.apply,nativeOpen=window.open,around=parent,portPost=MessagePort.prototype.postMessage;
  const stop=Event.prototype.stopImmediatePropagation;
  const getter=(prototype,name)=>Object.getOwnPropertyDescriptor(prototype,name).get;
  const eventData=getter(MessageEvent.prototype,'data'),eventSource=getter(MessageEvent.prototype,'source'),eventPorts=getter(MessageEvent.prototype,'ports');
  const activation=navigator.userActivation,isActive=activation?getter(Object.getPrototypeOf(activation),'isActive'):null;
  const native=()=>!!window.ReactNativeWebView;
  const framed=()=>native()||around!==window;
  // The page around the app hands this script, and only it, the way to ask for a page: it listens
  // before any of the app's listeners and keeps the message from them.
  let port=null;
  addEventListener('message',e=>{const data=apply(eventData,e,[]);
    if(apply(eventSource,e,[])!==around||!data||data.type!=='${appLinkPortMessage}')return;
    apply(stop,e,[]);const given=apply(eventPorts,e,[])[0];if(!port&&given)port=given},true);
  // A phone's WebView opens a window only for a person's tap, and its native side decides where.
  // In a frame, this asks the page around the app, and only for a press inside this frame, which
  // is this frame's own user activation: the app cannot fake it, and a press outside never gives it.
  // A browser spends a press on the window it opens: one press, one page. Presses are counted here,
  // before any of the app's listeners, and only the browser's own: the app can neither make one up
  // nor keep one from this count, and a press spent on a page opens no second one. Each is also told
  // to the page around the app on this script's own port, which the app cannot write to, so a page
  // the app leaves for by any other way (a navigation desktop main catches) spends one too.
  let presses=0,spent=0;
  const press=e=>{if(!e.isTrusted||e.repeat)return;presses++;if(port)apply(portPost,port,[{press:true}])};
  addEventListener('pointerdown',press,true);addEventListener('keydown',press,true);
  const leave=(href,trusted)=>{
    if(native()){apply(nativeOpen,window,[href,'_blank','noopener']);return}
    if(!(isActive?apply(isActive,activation,[]):trusted))return;
    if(spent===presses)return;spent=presses;
    // Before the port arrives, the window goes where this frame's windows always went.
    if(port)apply(portPost,port,[{url:href}]);else apply(nativeOpen,window,[href,'_blank','noopener']);
  };
  addEventListener('click',e=>{const a=e.target instanceof Element&&e.target.closest('a[href]');if(!a||e.defaultPrevented||!framed())return;
    // A browser keeps its own gestures for a link: a modifier opens it as that browser would.
    if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    const href=departure(a.href,location.href);if(href===null)return;
    e.preventDefault();leave(href,e.isTrusted);
  });
  // Only a plain new window for a page is a link, and returns null as a noopener window does. A
  // named window or one with features, as a sign-in popup the app watches is opened, keeps the
  // browser's own.
  const plain=(target,features)=>(target===undefined||target===''||String(target).toLowerCase()==='_blank')&&
    String(features??'').split(/[\\s,]+/).every(feature=>feature===''||/^(noopener|noreferrer)$/i.test(feature));
  window.open=function(url,target,features){
    const href=url===undefined||url===null||String(url)===''||!framed()||(!isActive&&!native())||!plain(target,features)?null:departure(String(url),location.href);
    if(href===null)return apply(nativeOpen,window,arguments);
    leave(href,false);return null;
  };
  window.${appReadyFlag}=true;
  send({type:'opensteer-app:ready'});
  let last=0, queued=false;
  const report=()=>{queued=false;const b=document.body;if(!b)return;
    const height=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+Math.max(0,b.getBoundingClientRect().top));
    if(height===last)return;last=height;
    send({type:'opensteer-app:size',height});
  };
  const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(report)}};
  addEventListener('message',e=>{if(e.source!==parent||!e.data||e.data.type!=='opensteer-app:theme')return;
    const theme=e.data.theme;if(theme!=='light'&&theme!=='dark')return;
    document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;
    dispatchEvent(new CustomEvent('opensteer:theme',{detail:{theme}}));schedule();
  });
  addEventListener('DOMContentLoaded',()=>{const observer=new ResizeObserver(schedule);observer.observe(document.body);observer.observe(document.documentElement);schedule()},{once:true});
  addEventListener('load',schedule);addEventListener('resize',schedule);
})();</script>`;
  const end = bootstrapOffset(html, doctype?.[0].length ?? "<!doctype html>".length);
  return html.slice(0, end) + bootstrap + html.slice(end);
}

/**
 * Where the bootstrap goes: past the doctype, then past the app's own opening
 * `<html>` and `<head>` tags if they come next, with only space and comments
 * between. Anything else the app wrote comes after it, so nothing of the
 * app's runs first, and a `<head>` mentioned in a later comment or script is
 * never mistaken for one. Placed before an opening tag the parser has already
 * implied, the app's attributes on it would be dropped.
 */
function bootstrapOffset(html: string, start: number): number {
  const filler = /^(?:\s|<!--[\s\S]*?-->)*/u;
  const attributes = String.raw`(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*>`;
  let at = start;
  for (const name of ["html", "head"]) {
    const skipped = at + filler.exec(html.slice(at))![0].length;
    const tag = new RegExp(`^<${name}${attributes}`, "iu").exec(html.slice(skipped));
    if (tag) at = skipped + tag[0].length;
  }
  return at;
}

export function appContentHeight(value: unknown): number | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "opensteer-app:size" ||
    !("height" in value)
  )
    return null;
  return typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0
    ? Math.min(100_000, Math.ceil(value.height))
    : null;
}

export function appFrameReady(value: unknown): boolean {
  return (
    !!value && typeof value === "object" && "type" in value && value.type === "opensteer-app:ready"
  );
}

/**
 * What the page around an app frame sends it, with the port on which the
 * frame's bootstrap, and nothing else in the frame, asks to open a page a
 * person followed out of the app.
 */
export const appLinkPortMessage = "opensteer-app:links";
const appLinkMaxLength = 8192;

/**
 * The web address a link leaves the app for, or null when it stays in the app,
 * stays on this page, or is not a web page. It runs inside the app's frame too,
 * so it may only use what it is given.
 */
export function appDeparture(value: string, document: string): string | null {
  try {
    const url = new URL(value, document);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.href.length > 8192) return null;
    const from = new URL(document);
    const prefix = /^\/v1\/(?:apps|plugin-pages)\/[^/]+\/(?:light|dark)\/[^/]+\//u.exec(
      from.pathname,
    )?.[0];
    if (
      url.protocol === from.protocol &&
      url.host === from.host &&
      (!prefix || url.pathname.startsWith(prefix))
    )
      return null;
    const href = url.href;
    url.hash = "";
    from.hash = "";
    return url.href === from.href ? null : href;
  } catch {
    return null;
  }
}

/** The web address an app frame's bootstrap asked to open, or null for anything else. */
/** Whether a message on an app's link port reports a press of the person's in that app's frame. */
export function appPressReport(value: unknown): boolean {
  return !!value && typeof value === "object" && "press" in value && value.press === true;
}

export function appLinkRequest(value: unknown): string | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    value.url.length > appLinkMaxLength
  )
    return null;
  try {
    const url = new URL(value.url);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Whether a link stays in this app: inside its capability prefix, or anywhere on its own origin. */
export function isAppNavigation(value: string, document: string): boolean {
  try {
    const from = new URL(document);
    const to = new URL(value, document);
    const prefix = /^\/v1\/(?:apps|plugin-pages)\/[^/]+\/(?:light|dark)\/[^/]+\//u.exec(
      from.pathname,
    )?.[0];
    return (
      to.protocol === from.protocol &&
      to.host === from.host &&
      (!prefix || to.pathname.startsWith(prefix))
    );
  } catch {
    return false;
  }
}
