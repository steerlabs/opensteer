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

export function prepareAppHtml(html: string, theme: AppTheme, realOrigin = false): string {
  const doctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/iu.exec(html);
  if (!doctype) html = "<!doctype html>" + html;
  const bootstrap = `<meta name="viewport" content="width=device-width, initial-scale=1"><script>
(()=>{${realOrigin ? appOriginScript : ""}
  ${appThemeScript(theme)}
  const isAppNavigation=${isAppNavigation.toString()};
  const send=message=>{
    if(parent!==window)parent.postMessage(message,'*');
    if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  send({type:'opensteer-app:ready'});
  addEventListener('click',e=>{const a=e.target instanceof Element&&e.target.closest('a[href]');if(!a||e.defaultPrevented)return;
    const url=new URL(a.href,location.href);
    if(isAppNavigation(url.href,location.href))return;
    if(!/^https?:$/.test(url.protocol))return;
    const here=new URL(location.href);url.hash='';here.hash='';if(url.href===here.href)return;
    e.preventDefault();open(a.href,'_blank','noopener');
  });
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
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (head) {
    const end = head.index + head[0].length;
    return html.slice(0, end) + bootstrap + html.slice(end);
  }
  const end = doctype?.[0].length ?? "<!doctype html>".length;
  return html.slice(0, end) + bootstrap + html.slice(end);
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

/** Whether a link stays in this app: inside its capability prefix, or anywhere on its own origin. */
export function isAppNavigation(value: string, document: string): boolean {
  try {
    const from = new URL(document);
    const to = new URL(value, document);
    const prefix = /^\/v1\/apps\/[^/]+\/(?:light|dark)\/[^/]+\//u.exec(from.pathname)?.[0];
    return (
      to.protocol === from.protocol &&
      to.host === from.host &&
      (!prefix || to.pathname.startsWith(prefix))
    );
  } catch {
    return false;
  }
}
