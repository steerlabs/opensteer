#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createContext, Script } from "node:vm";

// Build every helper inside the context: no host function or object crosses into agent JS.
// Tool calls leave the context as JSON through an outbox and return through __settle.
const statePath = process.env.OPENSTEER_EVAL_BROWSER_STATE;
const logPath = process.env.OPENSTEER_EVAL_BROWSER_LOG;
const toolsUrl = process.env.OPENSTEER_EVAL_TOOLS_URL;
const toolsToken = process.env.OPENSTEER_EVAL_TOOLS_TOKEN;
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--tab")) throw new Error("Use --tab <tabId>");
if (process.env.OPENSTEER_EVAL_BROWSER_DENIED === "1") {
  appendFileSync(
    logPath,
    JSON.stringify({ tool: "harness:denied", args: {}, at: Date.now(), valid: false }) + "\n",
  );
  process.stderr.write(
    JSON.stringify({
      error: {
        code: "access_denied",
        message: "Browser control requires full access for this Run.",
        next: "Use a full-access Run to control browser tabs.",
      },
    }) + "\n",
  );
  process.exit(1);
}
const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
  microtaskMode: "afterEvaluate",
});
const bootstrap = `
(() => {
let state = ${readFileSync(statePath, "utf8")};
const log = [], output = [], notices = [], outbox = [], pending = new Map();
let nextRequest = 0, bound;
const NO_PAGE = 'No tab is bound: pass --tab <tabId>, or use const p = await openPage(tabId).';
const personActivity = (t) => t.tabId === state.personActiveTab ? {kind:'typing', at:new Date().toISOString(), sinceLastAgentCommand:true} : undefined;
function record(call, args, fn) {
  const entry = {tool:'harness:' + call, args, at:Date.now(), valid:false}; log.push(entry);
  try { const result = fn(); entry.valid = true; return Promise.resolve(result); }
  catch(e) { entry.result = {error:e.message}; return Promise.reject(e); }
}
function coded(code, message) { const e = new Error(message); e.code = code; return e; }
function findTab(id) {
  const t = state.tabs.find(t => t.tabId === id);
  if (!t) throw coded('not_found', 'Tab ' + id + ' is closed or unknown. Find it again with tab_list.');
  return t;
}
function online(t) {
  if (state.offlineComputers.includes(t.computer)) throw coded('computer_offline', t.computer + ' is offline. Reconnect that computer to use this tab.');
  if (state.accessRequiredComputers.includes(t.computer)) throw coded('access_denied', 'Browser access is off on ' + t.computer + '. Use computer_access_request.');
}
function openPage(tabId) { return record('openPage', {tabId}, () => {
  const t = findTab(tabId);
  if (t.kind !== 'page') throw coded('unsupported', 'Tab ' + tabId + ' is a ' + t.kind + ' tab. Use computer_use tab(tabId) for windows and phones, or app_list and its localUrl for apps.');
  online(t);
  if (t.state === 'unavailable') throw coded('conflict', t.unavailableReason);
  t.state = 'open';
  if (!t.usedBy.includes('this-task')) t.usedBy.push('this-task');
  if (personActivity(t)) notices.push('[opensteer] The person typed in this page 3s ago. Look at the page again before continuing.');
  return handle(tabId);
}); }
function handle(tabId) {
  const tab = () => findTab(tabId);
  const r = (call, args, fn) => record(call, {tabId, ...args}, fn);
  const scripted = (name) => { if (tab().backend === 'actions') throw coded('unsupported', 'unsupported-operation: ' + name + ' is unavailable on iPhone pages.'); };
  const input = (call) => { const t = tab(); online(t); if (t.outcomeUnknown.includes(call)) { t.outcomeUnknown = t.outcomeUnknown.filter(c => c !== call); throw coded('outcome_unknown', 'outcome-unknown: the input was sent, but whether the page acted on it is unknown. Look at the page before acting again.'); } return true; };
  const info = (call) => r(call, {}, () => { const t = tab(); return {tabId:t.tabId, url:t.url, title:t.pageTitle ?? t.title, text:t.pageText ?? '', ...(personActivity(t) ? {userActivity: personActivity(t)} : {})}; });
  const text = (call, args = {}) => r(call, args, () => tab().pageText ?? '');
  const pageScript = (source) => /cookie/i.test(source) && tab().cookies ? tab().cookies.map(c => c.name + '=fixture').join('; ') : tab().pageText ?? '';
  const locator = (selector) => ({
    innerText:()=>text('page.innerText',{selector}), textContent:()=>text('page.textContent',{selector}),
    click:()=>r('page.click',{selector},()=>input('page.click')), fill:(value)=>r('page.fill',{selector,text:value},()=>input('page.fill')),
    press:(key)=>r('page.press',{selector,key},()=>input('page.press')), focus:()=>r('page.focus',{selector},()=>true),
    check:()=>r('page.check',{selector},()=>input('page.check')), isChecked:()=>r('page.isChecked',{selector},()=>false),
    isVisible:()=>r('page.isVisible',{selector},()=>true), count:()=>r('page.count',{selector},()=>1),
    waitFor:()=>r('page.waitFor',{selector},()=>true), ariaSnapshot:()=>text('page.ariaSnapshot',{selector}),
    first:()=>locator(selector), last:()=>locator(selector), nth:()=>locator(selector), filter:()=>locator(selector),
    getByRole:(role)=>locator(role), getByText:(t)=>locator(t), getByLabel:(l)=>locator(l), locator:(s)=>locator(s),
  });
  return {
    tabId,
    pageInfo:()=>info('pageInfo'), currentTab:()=>info('currentTab'), ensureRealTab:()=>info('ensureRealTab'),
    gotoUrl:(url)=>r('gotoUrl',{url},()=>{const t=tab(); online(t); t.url=url; return {url,title:t.pageTitle ?? t.title,text:t.pageText ?? ''};}),
    goto:(url)=>r('page.goto',{url},()=>{const t=tab(); online(t); t.url=url; return null;}),
    js:(source)=>r('js',{source:String(source)},()=>{scripted('js'); return pageScript(String(source));}),
    evaluate:(fn)=>r('page.evaluate',{source:String(fn)},()=>{scripted('evaluate'); return pageScript(String(fn));}),
    cdp:(method, params = {})=>r('cdp',{method,params},()=>{
      scripted('cdp'); online(tab());
      if (/^(Network|Storage)\\.get(All)?Cookies$/.test(method)) return {cookies: tab().cookies ?? []};
      if (method === 'Runtime.evaluate') return {result:{type:'string', value: tab().pageText ?? ''}};
      if (method === 'Page.captureScreenshot') return {data:'Zml4dHVyZQ=='};
      return {};
    }),
    waitForNetworkIdle:(options={})=>r('waitForNetworkIdle',options,()=>{scripted('waitForNetworkIdle'); return true;}),
    clickAt:(...args)=>r('clickAt',{args},()=>input('clickAt')),
    typeText:(value)=>r('typeText',{text:value},()=>input('typeText')),
    fillInput:(selector,value,options={})=>r('fillInput',{selector,text:value,...options},()=>input('fillInput')),
    fillLogin:(loginRef, field)=>r('fillLogin',{loginRef,field},()=>'filled'),
    fillCard:(cardRef, field)=>r('fillCard',{cardRef,field},()=>'filled'),
    pressKey:(key)=>r('pressKey',{key},()=>input('pressKey')),
    scroll:(...args)=>r('scroll',{args},()=>true),
    waitForLoad:()=>r('waitForLoad',{},()=>true), waitForElement:(selector)=>r('waitForElement',{selector},()=>true),
    waitForURL:()=>r('page.waitForURL',{},()=>true), waitForFunction:()=>r('page.waitForFunction',{},()=>{scripted('waitForFunction'); return true;}),
    waitForTimeout:()=>r('page.waitForTimeout',{},()=>true),
    captureScreenshot:()=>r('captureScreenshot',{},()=>({image:'fixture screenshot'})),
    screenshot:()=>r('page.screenshot',{},()=>'fixture screenshot'),
    setInputFiles:(target, files)=>r('setInputFiles',{target,files},()=>files),
    stageFiles:(files)=>r('stageFiles',{files},()=>files),
    drainEvents:()=>r('drainEvents',{},()=>[]),
    respondDialog:(answer)=>r('respondDialog',answer ?? {},()=>undefined),
    title:()=>r('page.title',{},()=>tab().pageTitle ?? tab().title), url:()=>r('page.url',{},()=>tab().url),
    ariaSnapshot:()=>text('page.ariaSnapshot'),
    locator, getByText:locator, getByRole:locator, getByLabel:locator,
    mouse:{click:(x,y)=>r('page.mouse.click',{x,y},()=>input('page.mouse.click'))},
    keyboard:{press:(key)=>r('page.keyboard.press',{key},()=>input('page.keyboard.press')), type:(value)=>r('page.keyboard.type',{text:value},()=>input('page.keyboard.type')), insertText:(value)=>r('page.keyboard.insertText',{text:value},()=>input('page.keyboard.insertText'))},
  };
}
const opensteer = { callTool: (name, input = {}) => {
  const id = ++nextRequest;
  outbox.push({id, payload:{name:String(name), input}});
  return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
} };
Object.defineProperty(globalThis, 'page', {get(){ if (!bound) throw new Error(NO_PAGE); return bound; }});
for (const name of ['pageInfo','currentTab','ensureRealTab','gotoUrl','js','cdp','clickAt','typeText','fillInput','fillLogin','fillCard','pressKey','scroll','waitForElement','waitForLoad','waitForNetworkIdle','captureScreenshot','setInputFiles','stageFiles','drainEvents','respondDialog'])
  globalThis[name] = (...args) => bound ? bound[name](...args) : Promise.reject(new Error(NO_PAGE));
globalThis.openPage = openPage;
globalThis.opensteer = opensteer;
globalThis.sleep = () => Promise.resolve();
globalThis.console = {log:(...args)=>output.push(args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ')), error:(...args)=>output.push(args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' '))};
globalThis.__bind = (handle) => { bound = handle; };
globalThis.__state = () => JSON.stringify(state);
globalThis.__takeOutbox = () => { const taken = JSON.stringify(outbox); outbox.length = 0; return taken; };
globalThis.__settle = (id, response, nextState) => {
  state = JSON.parse(nextState);
  const waiting = pending.get(id); pending.delete(id);
  const answer = JSON.parse(response);
  if (answer.ok) waiting.resolve(answer.value); else waiting.reject(new Error(answer.message));
};
globalThis.__snapshot = () => JSON.stringify({state,log,output,notices,failed:globalThis.failed,finished:globalThis.finished});
})()
`;
const run = (code) => new Script(code).runInContext(context, { timeout: 1000 });
run(bootstrap);

let failure;
try {
  run(
    `(async () => { ${args[1] ? `__bind(await openPage(${JSON.stringify(args[1])}));` : ""} ${readFileSync(0, "utf8")}\n })().then(() => {globalThis.finished=true;}, e => { console.log(e.message); globalThis.failed=true;globalThis.finished=true; });`,
  );
  // Each settle resumes the script until its next tool call; a bounded number of calls per script.
  for (let round = 0; round < 64; round++) {
    const requests = JSON.parse(run("__takeOutbox()"));
    if (!requests.length) break;
    for (const request of requests) {
      writeFileSync(statePath, run("__state()"));
      let response;
      try {
        if (!toolsUrl) throw new Error("opensteer.callTool is unavailable in this fixture");
        const answer = await fetch(toolsUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${toolsToken}`, "content-type": "application/json" },
          body: JSON.stringify(request.payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (!answer.ok) throw new Error(`Tool relay failed with ${answer.status}`);
        response = { ok: true, value: await answer.json() };
      } catch (error) {
        response = { ok: false, message: String(error) };
      }
      run(
        `__settle(${request.id}, ${JSON.stringify(JSON.stringify(response))}, ${JSON.stringify(readFileSync(statePath, "utf8"))})`,
      );
    }
  }
} catch (e) {
  failure = String(e);
}
const result = JSON.parse(run("__snapshot()"));
writeFileSync(statePath, JSON.stringify(result.state));
for (const entry of result.log) appendFileSync(logPath, JSON.stringify(entry) + "\n");
for (const line of result.output) process.stdout.write(line + "\n");
for (const line of result.notices) process.stderr.write(line + "\n");
if (failure || result.failed || !result.finished) {
  if (!failure && !result.failed) failure = "Browser script did not finish";
  if (failure) process.stderr.write(failure + "\n");
  process.exitCode = 1;
}
