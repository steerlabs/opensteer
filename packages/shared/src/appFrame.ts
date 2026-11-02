/** Kept identical on HTTP and Electron's isolated app scheme. */
export const appFrameScheme = "opensteer-app";
export const appFrameSandbox = "allow-scripts allow-popups";
export const appFrameContentSecurityPolicy = [
  `sandbox ${appFrameSandbox}`,
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

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

export function prepareAppHtml(html: string, theme: AppTheme): string {
  const doctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/iu.exec(html);
  if (!doctype) html = "<!doctype html>" + html;
  const bootstrap = `<meta name="viewport" content="width=device-width, initial-scale=1"><script>
(()=>{
  ${appThemeScript(theme)}
  const send=message=>{
    if(parent!==window)parent.postMessage(message,'*');
    if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  send({type:'opensteer-app:ready'});
  addEventListener('keydown',e=>{if(e.key==='Escape')send({type:'opensteer-app:escape'})});
  addEventListener('click',e=>{const a=e.target instanceof Element&&e.target.closest('a[href]');if(!a||e.defaultPrevented)return;
    const url=new URL(a.href,location.href);if(!/^https?:$/.test(url.protocol))return;
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
