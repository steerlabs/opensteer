import type { IncomingMessage, ServerResponse } from "node:http";
export function serveBrowserPopupFixture(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (request.url !== "/popups") return false;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser popup fixture</title>
<style>body{font:16px system-ui;margin:16px;display:grid;grid-template-columns:1fr 1fr;gap:10px}label{display:flex;flex-direction:column;gap:3px;min-width:0}input,select,button{font:inherit;min-height:36px;min-width:0}datalist{display:none}</style>
<label>Single <select id="single"><optgroup label="Group"><option value="private-a">Alpha</option><option disabled value="private-disabled">Disabled</option><option value="private-b">Beta</option></optgroup></select></label>
<label>Multiple <select id="multiple" multiple size="1"><option value="private-a" selected>Alpha</option><option value="private-b">Beta</option><option value="private-disabled" disabled selected>Disabled</option></select></label>
<label>Date <input id="date" type="date" value="2024-03-10"></label>
<label>Time <input id="time" type="time" step="0.001" value="01:59:59.123"></label>
<label>Date and time <input id="datetime-local" type="datetime-local" step="0.001" value="2024-11-03T01:30:00.125"></label>
<label>Month <input id="month" type="month" value="2024-12"></label><label>Week <input id="week" type="week" value="2020-W53"></label>
<label>Color <input id="color" type="color" alpha colorspace="display-p3" value="color(display-p3 0.9 0.2 0.1 / 0.35)"></label>
<label>Suggestions <input id="datalist" list="suggestions"><datalist id="suggestions"><option value="Alpha" label="First"><option value="Beta" label="Second"><option value="漢字" label="Commit"></datalist></label>
<label>IME suggestions <input id="ime" list="suggestions"></label>
<button id="local-date">Local date</button><button id="local-color">Local color</button>
<button id="successor">Successor on next selection</button>
<script>
window.fixture={clicks:0};document.addEventListener("click",()=>fixture.clicks++);window.popupResults={};for(const input of document.querySelectorAll('input,select')) {window.popupResults[input.id]={input:0,change:0,presses:0};input.addEventListener("mousedown",()=>{window.popupResults[input.id].presses++});for(const kind of ['input','change']) input.addEventListener(kind,()=>{window.popupResults[input.id][kind]++})}
window.mutatePopup=()=>{document.querySelector('#single option').textContent='Changed choice'};
window.replacePopup=()=>{const old=document.querySelector('#single');const next=old.cloneNode(true);old.replaceWith(next)};
document.querySelector('#local-date').onclick=()=>document.querySelector('#date').showPicker();
document.querySelector('#local-color').onclick=()=>document.querySelector('#color').showPicker();
document.querySelector('#successor').onclick=()=>document.querySelector('#single').addEventListener('change',()=>document.querySelector('#date').showPicker(),{once:true});
</script>`);
  return true;
}
