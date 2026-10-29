import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";

/** Shared local site for hosted, native Electron and real-engine action journeys. */
export async function serveHarnessActionsFixture(directory = new URL("./", import.meta.url)) {
  const reactEntry = new URL("./harness-actions-react.fixture.mjs", directory);
  const bundle = await build({
    entryPoints: [fileURLToPath(reactEntry)],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const react = bundle.outputFiles[0]!.text;
  const requests: { path: string; at: number }[] = [];
  const submissions: {
    nonce: string;
    capacity: string;
    zip: string;
    count: number;
    resultId: string;
    availability: string;
  }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    requests.push({ path: `${url.pathname}${url.search}`, at: Date.now() });
    if (url.pathname === "/react.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(react);
      return;
    }
    if (url.pathname === "/pickup") {
      const parsed = z
        .object({
          nonce: z.string().min(1),
          capacity: z.enum(["256gb", "512gb", "1tb"]),
          zip: z.string().regex(/^\d{5}$/),
        })
        .safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) {
        response.writeHead(400).end("Malformed pickup request");
        return;
      }
      const count = submissions.filter((s) => s.nonce === parsed.data.nonce).length + 1;
      const submission = {
        ...parsed.data,
        count,
        resultId: createHash("sha256")
          .update(JSON.stringify([parsed.data, count]))
          .digest("hex")
          .slice(0, 16),
        availability: "Available for pickup",
      };
      submissions.push(submission);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(submission));
      return;
    }
    const id = url.pathname.split("/").at(-1) ?? "01";
    const content = pages[id];
    if (!content) {
      response.writeHead(404).end("Unknown action fixture");
      return;
    }
    // Case 22 is a strict-CSP site: page scripts may not eval, as on many large sites.
    const nonce = id === "22" ? "fixture-nonce" : undefined;
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
      ...(nonce
        ? { "content-security-policy": `script-src 'nonce-${nonce}'; object-src 'none'` }
        : {}),
    });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Actions ${id}</title>
      <style>${styles}</style></head><body><h1>Browser actions ${id}</h1>${content}
      <script${nonce ? ` nonce="${nonce}"` : ""}>${common}\n${scripts[id] ?? ""}\nwindow.fixture.ready = true;</script>
      ${id === "05" || id === "engine" ? '<script src="/react.js"></script>' : ""}</body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  let closing: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    url: (id: string) => `http://127.0.0.1:${address.port}/case/${id}`,
    requests,
    submissions,
    sha256: createHash("sha256")
      .update(await readFile(new URL("./harness-actions-fixture.ts", directory)))
      .update(await readFile(reactEntry))
      .update(react)
      .digest("hex"),
    close: () => (closing ??= closeHttpServerNow(server)),
  };
}

const styles = `
  body { margin: 24px; font: 16px system-ui; color: #182030; background: #f5f6f8 }
  button,input,select,textarea,[contenteditable] { font: inherit; margin: 8px; padding: 12px }
  button,label { cursor: pointer } button { min-width: 130px; min-height: 48px }
  label { display: inline-block } .hidden { display: none }
  #capacities { height: 180px; width: 360px; overflow-y: scroll; border: 2px solid #344; }
  .capacity { display: flex; height: 180px; box-sizing: border-box; align-items: center; justify-content: center;
    border: 2px solid #657; margin: 0; position: relative; background: white; }
  .capacity:has(:checked) { background: #b7e2ff }
  .capacity input,.tiny { position:absolute; width:1px; height:1px; clip-path:inset(50%); padding:0; margin:0 }
  #overlay { position: fixed; inset: 0; background: #777b; z-index: 100; }
  #hover-zone { position:relative; height:200px } #hover-target { position:absolute; left:40px; top:20px }
  #decoy { position:absolute; left:40px; top:20px }
  #moving { position:relative } @keyframes slide { from { left:0 } to { left:400px } }
`;

const common = `
window.fixture = { ready:false, counts:{}, trusted:[], events:[], submissions:[], answers:[], reactChanges:0 };
window.hit = (id,event) => { fixture.counts[id]=(fixture.counts[id]||0)+1;
  fixture.trusted.push({ id, trusted:event.isTrusted }); };
document.addEventListener('input',e=>fixture.events.push({type:'input',id:e.composedPath()[0].id,composed:e.composed}));
document.addEventListener('change',e=>fixture.events.push({type:'change',id:e.composedPath()[0].id,composed:e.composed}));
document.addEventListener('keydown',e=>fixture.events.push({type:'keydown',key:e.key,code:e.code,keyCode:e.keyCode,
  location:e.location,shift:e.shiftKey,ctrl:e.ctrlKey,meta:e.metaKey,alt:e.altKey,trusted:e.isTrusted}));
document.addEventListener('keyup',e=>fixture.events.push({type:'keyup',key:e.key,code:e.code,
  shift:e.shiftKey,ctrl:e.ctrlKey,meta:e.metaKey,alt:e.altKey,trusted:e.isTrusted}));
`;

const zip = `<form id="zip-form"><label>ZIP<input id="zip" data-autom="zipCode" aria-label="ZIP" value="10014"></label>
<button>Find pickup</button></form><ul id="results"></ul>`;
const zipScript = `document.querySelector('#zip-form').onsubmit=e=>{e.preventDefault();
  const zip=document.querySelector('#zip').value;fixture.submissions.push(zip);
  document.querySelector('#results').innerHTML='<li>Pickup for '+zip+'</li><li>SoHo</li><li>Fifth Avenue</li>';};`;

const pages: Record<string, string> = {
  "01": `<section role="dialog" aria-label="Pickup"><div id="capacities">${["256GB", "512GB", "1TB"]
    .map(
      (name, i) =>
        `<label class="capacity" for="capacity-${i}"><input id="capacity-${i}" name="pl_dimensionCapacity" type="radio" value="${name.toLowerCase()}" ${i === 0 ? "checked" : ""}>${name}</label>`,
    )
    .join("")}</div>${zip}</section>`,
  "02": `<div role="dialog" aria-label="Old" hidden><button class="duplicate" onclick="hit('hidden',event)">Continue</button></div>
    <div role="dialog" aria-label="Current"><button class="duplicate" onclick="hit('visible',event)">Continue</button></div>`,
  "03": `<button id="moving" onclick="hit('moving',event);fixture.clickedAfterMotion=fixture.motionFinished;fixture.clickX=event.clientX">Sliding button</button>`,
  "04": `<button id="covered" onclick="hit('covered',event)">Covered action</button><div id="overlay" class="overlay">Blocking overlay</div>`,
  "05": `<div id="react-root"></div><div id="shadow-host"></div><label>Number<input id="number" type="number"></label>
    <label>Date<input id="date" type="date"></label><div id="editor" contenteditable="true"><p><b>Nested old text</b></p></div>
    <label>Replace on focus<input id="replace" value="old"></label><input id="readonly" readonly value="protected">
    <input id="aria-readonly" aria-readonly="true" value="protected"><input id="file" type="file"><input id="checkbox" type="checkbox">`,
  "06": zip,
  "07": `<div id="shadow-host"></div>`,
  "08": `<div id="hover-zone"><button id="hover-target" onclick="hit('obsolete',event)">Live action</button></div>`,
  "09": `<button id="disabled" disabled onclick="hit('disabled',event)">Native disabled</button>
    <fieldset disabled><button id="fieldset" onclick="hit('fieldset',event)">Fieldset disabled</button></fieldset>
    <div aria-disabled="true"><button id="aria-disabled" onclick="hit('aria-disabled',event)">ARIA disabled</button></div>
    <button onclick="hit('available',event)">Available action</button>`,
  "10": `<label>Prevented<input id="prevented" type="checkbox" onclick="hit('prevented',event);event.preventDefault()"></label>
    <label>Working<input id="working" type="checkbox" onclick="hit('working',event)"></label>`,
  "11": `<label>Shipping<select id="shipping"><option value="slow">Economy</option><option value="fast">Express</option></select></label>
    <select id="multi" multiple><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>`,
  "12": `<button onclick="hit('healthy',event)">Still usable</button>`,
  "13": `<button id="down">Down dialog</button><button id="click">Click dialog</button>
    <input id="key" aria-label="Key dialog"><button id="chain">Dialog chain</button>
    <input id="keyup" aria-label="Key release dialog"><input id="focus-dialog" aria-label="Focus dialog">
    <input id="modifier-up" aria-label="Modifier release dialog">`,
  "14": `<input id="before" aria-label="Before"><input id="keys" aria-label="Keys"><input id="after" aria-label="After">`,
  "15": `<button id="background" onclick="hit('background',event)">Background action</button><input id="background-input">`,
  "16": `<button id="resize" style="position:absolute;left:55vw;top:55vh" onclick="hit('resize',event);fixture.point={x:event.clientX,y:event.clientY,dpr:devicePixelRatio,w:innerWidth,h:innerHeight}">Resize action</button>`,
  "17": `<section id="small" role="region" aria-label="Pickup summary"><h2>Pickup</h2>
    <label>ZIP<input value="10014"></label><label><input type="checkbox" checked>Notify me</label>
    <button onclick="hit('snapshot',event)">Reserve pickup</button></section><div id="large"></div>`,
  "18": `<button id="navigate" onclick="hit('navigate',event);sessionStorage.setItem('activations',String(Number(sessionStorage.getItem('activations')||0)+1));location.href='/case/18?after=1'">Navigate once</button>`,
  "19": `<label id="external" for="external-input">External label</label><label id="ref">Referenced label</label>
    <section id="scope"><input id="external-input"><input id="aria-label" aria-label="ARIA label">
    <input id="labelledby" aria-labelledby="ref"><label>Wrapping label<input id="wrapped"></label>
    <input id="placeholder" placeholder="Placeholder only"><input id="title-only" title="Title only">
    <button id="text-only">Own text only</button><button id="owned" aria-owns="outside">Scope owner</button>
    <button class="ordered">First ordered</button><button class="ordered">Second ordered</button></section>
    <button id="outside">Outside owned</button><button id="ignored" aria-hidden="true">Ignored action</button>
    <label id="danger-label" for="danger"><input id="danger" type="checkbox" class="tiny"><a href="#link" style="display:block;padding:25px">Nested link</a></label>`,
  "22": `<button id="csp">CSP action</button><label>CSP field<input id="csp-field"></label>`,
  "20": `${zip}<input class="legacy" value="first"><input class="legacy" value="second"><button id="legacy" onclick="hit('legacy',event)">Legacy action</button>`,
};

const scripts: Record<string, string> = {
  "22": `try { eval("1"); fixture.evalAllowed = true; } catch { fixture.evalAllowed = false; }
document.querySelector('#csp').onclick=e=>hit('csp',e);`,
  "01": `${zipScript}\ndocument.querySelectorAll('.capacity input').forEach(e=>e.addEventListener('click',event=>hit(e.value,event)));`,
  "03": `fixture.motionFinished=false;window.startMotion=()=>{const e=document.querySelector('#moving');e.style.animation='slide 1.5s linear forwards';e.onanimationend=()=>fixture.motionFinished=true;};`,
  "05": `document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<label>Shadow input<input id="shadow-input"></label>';
    document.querySelector('#replace').onfocus=e=>{const next=e.target.cloneNode();e.target.replaceWith(next);fixture.focusReplacements=(fixture.focusReplacements||0)+1;};`,
  "06": zipScript,
  "07": `document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow action</button>';
    document.querySelector('#shadow-host').shadowRoot.querySelector('button').onclick=e=>hit('shadow',e);`,
  "08": `document.querySelector('#hover-target').onmouseenter=e=>{if(fixture.hoverReplaced)return;fixture.hoverReplaced=true;
    const live=e.target.cloneNode(true);live.style.left='420px';live.onmouseenter=null;live.onclick=e=>hit('live',e);
    e.target.replaceWith(live);const decoy=document.createElement('button');decoy.id='decoy';decoy.textContent='Unrelated control';
    decoy.onclick=e=>hit('decoy',e);document.querySelector('#hover-zone').append(decoy);};`,
  "09": `window.enableButtons=()=>{document.querySelectorAll('[disabled]').forEach(e=>e.disabled=false);document.querySelector('[aria-disabled]').removeAttribute('aria-disabled');};`,
  "13": `for(const [id,phase] of [['down','mousedown'],['click','click'],['key','keydown']])
    document.getElementById(id).addEventListener(phase,e=>{hit(id,e);fixture.answers.push({id,answer:confirm(id+' confirm')});});
    document.querySelector('#keyup').addEventListener('keyup',e=>{hit('keyup',e);fixture.answers.push({id:'keyup',answer:confirm('keyup confirm')});});
    document.querySelector('#focus-dialog').addEventListener('focus',e=>{hit('focus',e);fixture.answers.push({id:'focus',answer:confirm('focus confirm')});});
    document.querySelector('#modifier-up').addEventListener('keyup',e=>{if(e.key!=='Shift')return;hit('modifier',e);fixture.answers.push({id:'modifier',answer:confirm('modifier confirm')});});
    document.querySelector('#chain').onclick=e=>{hit('chain',e);fixture.answers.push({id:'A',answer:confirm('A')});fixture.answers.push({id:'B',answer:confirm('B')});};`,
  "15": `fixture.geometrySamples=[];fixture.pageTimerCalls=[];
    for(const id of ['background','background-input']) {
      const element=document.getElementById(id);
      for(const method of ['getBoundingClientRect','getClientRects']) {
        const native=element[method].bind(element);
        element[method]=(...args)=>{fixture.geometrySamples.push({id,method,at:performance.now(),visibilityState:document.visibilityState});return native(...args);};
      }
    }
    window.blockPageTimers=()=>{for(const name of ['setTimeout','setInterval','requestAnimationFrame'])
      window[name]=()=>{fixture.pageTimerCalls.push(name);throw new Error('Page timer disabled by background sampling fixture: '+name);};};`,
  "17": `window.addLargeAX=()=>{const fragment=document.createDocumentFragment();for(let i=0;i<5000;i++){
    const button=document.createElement('button');button.textContent='Large option '+i+' '+ 'x'.repeat(100);fragment.append(button);}
    document.querySelector('#large').append(fragment);fixture.largeCount=5000;};`,
  "18": `fixture.persistedActivations=Number(sessionStorage.getItem('activations')||0);`,
  "20": zipScript,
};

// The real-engine journey combines the same capacity picker with a React ZIP
// form and a server-owned result identity, so its oracle does not trust agent output.
pages.engine = pages["01"]!.replace(zip, '<div id="pickup-react-root"></div>');
scripts.engine = `document.querySelectorAll('.capacity input').forEach(e=>e.addEventListener('click',event=>hit(e.value,event)));`;
