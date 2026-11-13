#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createContext, Script } from "node:vm";

// Build every helper inside the context: no host function or object crosses into agent JS.
const statePath = process.env.OPENSTEER_EVAL_BROWSER_STATE;
const logPath = process.env.OPENSTEER_EVAL_BROWSER_LOG;
const fixture = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--tab")) throw new Error("Use --tab <tabId>");
const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
  microtaskMode: "afterEvaluate",
});
const bootstrap = `
(() => {
const state = ${JSON.stringify(fixture)};
const log = [], output = [];
// Like the real executable, each invocation starts with no tab unless --tab names one.
let selected;
const personActivity = (t) => t.tabId === state.personActiveTab ? {kind:'typing', at:new Date().toISOString(), sinceLastAgentCommand:true} : undefined;
const notices = [];
function record(call, args, fn) {
  const entry = {tool:'harness:' + call, args: {...(selected && !('tabId' in args) ? {tabId: selected} : {}), ...args}, at:Date.now(), valid:false}; log.push(entry);
  try { const result = fn(); entry.valid = true; return Promise.resolve(result); }
  catch(e) { entry.result = {error:e.message}; return Promise.reject(e); }
}
function tab(id = selected) {
  if (id === undefined) throw new Error('Call switchTab(tabId) or newTab(url, { profile: "<name>" }) or newTab(url, { guest: true }) before using page helpers.');
  const t = state.tabs.find(t => t.tabId === id);
  if (!t) throw new Error('Tab ' + id + ' is closed or unavailable. Select a listed tab.');
  return t;
}
function online(t) {
  if (state.offlineComputers.includes(t.computer)) throw new Error(t.computer + ' is offline. Reconnect that computer to use this tab.');
  if (state.accessRequiredComputers.includes(t.computer)) throw new Error('Browser access required on ' + t.computer + '. Use device_access_request.');
}
function listTabs(options = {}) { return record('listTabs', options, () => {
  const q = (options.query ?? '').toLowerCase();
  const rows = state.tabs.filter(t => (!options.state || t.state === options.state) && [t.title,t.url,t.profile?.name,t.groupId].some(v => (v ?? '').toLowerCase().includes(q)));
  return rows.slice(0, options.all ? undefined : options.limit ?? 50).map(({pageText,pageTitle,current,...t}) => ({...t, ...(t.tabId === selected ? {current:true} : {})}));
}); }
function switchTab(value) { const id = typeof value === 'string' ? value : value.tabId; return record('switchTab', {tabId:id}, () => { const t = tab(id); online(t); selected = id; t.state='open'; t.usedByThisTask=true; if (personActivity(t)) notices.push('[opensteer] The person typed in this page 3s ago. Look at the page again before continuing.'); return id; }); }
function newTab(url='about:blank', options={}) { return record('newTab', {url,...options}, () => {
  let profile = null, computer = options.computer ?? null;
  if (options.profile) { const matches = state.profiles.filter(p => p.id === options.profile || p.name.toLowerCase() === options.profile.toLowerCase()); if(matches.length !== 1) throw new Error('Profile not found or ambiguous'); log.at(-1).args.profile=matches[0].id; profile={id:matches[0].id,name:matches[0].name}; computer=matches[0].computer ?? null; }
  else if (!options.guest) { if(!selected) throw new Error('Call switchTab(tabId) or newTab(url, { profile: "<name>" }) or newTab(url, { guest: true }) before using page helpers.'); const t = tab(); profile=t.profile; computer=t.computer; }
  online({computer});
  const tabId = 'eval-tab-' + (state.nextTab = (state.nextTab ?? 0) + 1);
  state.tabs.push({tabId,title:url,url,profile,computer,state:'open',usedByThisTask:true,usedByOtherTask:false,groupId:null,pageText:state.tabs.find(t => t.url === url)?.pageText ?? 'Fixture page'});
  selected=tabId; return tabId;
}); }
function closeTab(id=selected) { return record('closeTab', {tabId:id}, () => { const t=tab(id); online(t); state.tabs=state.tabs.filter(t=>t.tabId!==id); if(selected===id) selected=undefined; return {closed:[id],failed:[]}; }); }
function organizeTabs(input) { return record('organizeTabs', input, () => {
  const tabs = (input.tabIds ?? []).map(id => tab(id));
  if (input.action === 'group') { const id = 'eval-group-' + (state.nextGroup = (state.nextGroup ?? 0) + 1); for(const t of tabs)t.groupId=id; return {groupId:id}; }
  if (input.action === 'ungroup') { for(const t of tabs)t.groupId=null; }
  else if(input.action === 'move') { for(const t of tabs)t.groupId=input.toGroupId ?? null; state.tabs=state.tabs.filter(t=>!tabs.includes(t)); const before=state.tabs.findIndex(t=>t.tabId===input.before || t.groupId===input.before); state.tabs.splice(before<0?state.tabs.length:before,0,...tabs); }
  else if(input.action !== 'update_group') throw new Error('Use group, ungroup, move or update_group');
  return {status:'ok'};
}); }
function currentTab() { return record('currentTab', {}, () => { const {pageText,pageTitle,...t}=tab(); return {...t, ...(personActivity(t) ? {userActivity: personActivity(t)} : {})}; }); }
function pageInfo() { return record('pageInfo', {}, () => {const t=tab(); return {tabId:t.tabId,url:t.url,title:t.pageTitle ?? t.title,text:t.pageText ?? '', ...(personActivity(t) ? {userActivity: personActivity(t)} : {})};}); }
function gotoUrl(url) { return record('gotoUrl', {url}, () => {const t=tab(); online(t);t.url=url;return {url,title:t.pageTitle ?? t.title,text:t.pageText ?? ''};}); }
function js(source) { return record('js', {source:String(source)}, () => tab().pageText ?? ''); }
const console = {log:(...args)=>output.push(args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' '))};
const page = {ariaSnapshot:()=>record('page.ariaSnapshot',{},()=>tab().pageText ?? ''), title:()=>record('page.title',{},()=>tab().pageTitle ?? tab().title), url:()=>record('page.url',{},()=>tab().url),
  locator: selector => locator(selector), getByText: text => locator(text), getByRole: role => locator(role), getByLabel: label => locator(label)};
function locator(selector) { return {innerText:()=>record('page.innerText',{selector},()=>tab().pageText ?? ''),textContent:()=>record('page.textContent',{selector},()=>tab().pageText ?? ''),click:()=>clickAt(selector),fill:text=>fillInput(selector,text),press:key=>pressKey(key),focus:()=>record('page.focus',{selector},()=>true)}; }
function clickAt(...args) {return record('clickAt',{args},()=>true);}
function typeText(text) {return record('typeText',{text},()=>true);}
function fillInput(selector,text,options={}) {return record('fillInput',{selector,text,...options},()=>true);}
function fillLogin(input) {return record('fillLogin',input,()=>({filled:true}));}
function fillCard(input) {return record('fillCard',input,()=>({filled:true}));}
function pressKey(key) {return record('pressKey',{key},()=>true);}
function scroll(...args) {return record('scroll',{args},()=>true);}
function waitForLoad() {return record('waitForLoad',{},()=>true);}
function captureScreenshot() {return record('captureScreenshot',{},()=>({image:'fixture screenshot'}));}
return { helpers: {listTabs,switchTab,newTab,closeTab,organizeTabs,currentTab,pageInfo,gotoUrl,js,console,page,clickAt,typeText,fillInput,fillLogin,fillCard,pressKey,scroll,waitForLoad,captureScreenshot}, snapshot: () => JSON.stringify({state,log,output,notices,selected,failed:globalThis.failed,finished:globalThis.finished}) };
})()
`;
const bridge = new Script(bootstrap).runInContext(context, { timeout: 1000 });
Object.assign(context, bridge.helpers);

let failure;
try {
  new Script(
    `(async () => { ${args[1] ? `await switchTab(${JSON.stringify(args[1])});` : ""} ${readFileSync(0, "utf8")}\n })().then(() => {globalThis.finished=true;}, e => { console.log(e.message); globalThis.failed=true;globalThis.finished=true; });`,
  ).runInContext(context, { timeout: 1000 });
} catch (e) {
  failure = String(e);
}
context.__evalSnapshot = bridge.snapshot;
const result = JSON.parse(new Script("__evalSnapshot()").runInContext(context, { timeout: 1000 }));
writeFileSync(statePath, JSON.stringify(result.state));
for (const entry of result.log) appendFileSync(logPath, JSON.stringify(entry) + "\n");
for (const line of result.output) process.stdout.write(line + "\n");
for (const line of result.notices) process.stderr.write(line + "\n");
if (failure || result.failed || !result.finished) {
  if (!failure && !result.failed) failure = "Browser script did not finish";
  if (failure) process.stderr.write(failure + "\n");
  process.exitCode = 1;
}
