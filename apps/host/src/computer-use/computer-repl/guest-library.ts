// This program runs inside QuickJS. Only the two captured bridge functions cross
// the worker boundary; handles and snapshots never leave their Run's context.
export const computerGuestLibrary = String.raw`
(() => {
  const bridge = globalThis.__computerCall;
  const write = globalThis.__computerPrint;
  delete globalThis.__computerCall;
  delete globalThis.__computerPrint;
  class ComputerError extends Error {
    constructor(code, message, performed = []) { super(message); this.name = "ComputerError"; this.code = code; this.performed = performed; }
  }
  async function call(operation, target = null, args = {}) {
    const result = JSON.parse(await bridge(JSON.stringify({operation,target,args})));
    if (result.error) throw new ComputerError(result.error.code,result.error.message,result.error.performed);
    return result.value;
  }
  globalThis.ComputerError = ComputerError;
  globalThis.print = (...values) => write(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
  globalThis.sleep = ms => call("sleep",null,{ms});
  globalThis.apps = () => call("apps");
  globalThis.phones = () => call("phones");
  async function resolve(kind, query, computer) {
    const entries = await call(kind);
    const q = String(query).toLowerCase();
    const matches = entries.filter(entry => [entry.id,entry.name,entry.bundleId].some(value => value && value.toLowerCase() === q) && (!computer || entry.computer === computer));
    if(matches.length !== 1) throw new ComputerError("app-not-allowed",matches.length ? "Choose one: " + matches.map(entry=>entry.name+" on "+entry.computer).join(", ") : "No approved " + (kind === "apps" ? "app" : "phone") + " matches " + query + ". Search integrations for access.");
    return matches[0];
  }
  const windowStates = new Map();
  class App {
    constructor(entry) { this.id=entry.id; this.name=entry.name; this.computer=entry.computer; }
    windows() { return call("windows",this.id); }
    async window(id = null) {
      const result = await call("bind",this.id,{window:id});
      const info = result.window;
      const key = this.id + ":" + info.ref;
      let state=windowStates.get(key);
      if(!state) {state={snapshot:null,ref:info.ref};windowStates.set(key,state);}
      return new Window(this.id,info,state);
    }
  }
  function target(value) { return typeof value === "number" ? {index:value} : Array.isArray(value) ? {x:value[0],y:value[1]} : value; }
  class Window {
    #app; #state;
    constructor(app, info, state) { this.#app=app; this.#state=state; this.id=info.id; this.title=info.title; }
    async observe({screenshot=false,emit=true}={}) {
      const result=await call("observe",this.#app,{window:this.#state.ref,includeScreenshot:screenshot,emit});
      this.#state.snapshot=result.observation.snapshot;
      return result.observation;
    }
    async #act(operation,actions) {
      // Snapshot is read at FIFO dispatch, after earlier observations settle.
      return call(operation,this.#app,{window:this.#state.ref,actions});
    }
    click(value,{button="left",count=1}={}) {return this.#act("click",[{type:"click",target:target(value),button,count}]);}
    type(text,{into}={}) {return this.#act("type",[{type:"type",text,...(into === undefined ? {} : {target:target(into)})}]);}
    key(keys) {return this.#act("key",[{type:"key",keys}]);}
    setValue(index,value) {return this.#act("setValue",[{type:"setValue",index,value}]);}
    scroll(value,direction,amount=1) {return this.#act("scroll",[{type:"scroll",target:target(value),direction,amount}]);}
    act(actions) {return this.#act("act",actions);}
  }
  globalThis.app = async (query,{computer}={}) => new App(await resolve("apps",query,computer));
  const phoneStates=new Map();
  class Phone {
    #state;
    constructor(entry) {this.id=entry.id;this.name=entry.name;let state=phoneStates.get(entry.id);if(!state){state={observationId:null};phoneStates.set(entry.id,state);}this.#state=state;}
    async observe() {const result=await call("observe",this.id);this.#state.observationId=result.observation.observationId;return result.observation;}
    async act(actions) {try {const result=await call("act",this.id,{actions});this.#state.observationId=result.observation?.observationId ?? null;return result.observation;}catch(error){this.#state.observationId=null;throw error;}}
    async release() {try{return await call("release",this.id);}finally{this.#state.observationId=null;}}
    tap(value) {return this.act([{type:"tap",target:target(value)}]);}
    longPress(value,durationMs=500) {return this.act([{type:"longPress",target:target(value),durationMs}]);}
    swipe(from,to,durationMs=300) {return this.act([{type:"swipe",from:target(from),to:target(to),durationMs}]);}
    drag(from,to,durationMs=500) {return this.act([{type:"drag",from:target(from),to:target(to),durationMs}]);}
    type(text,{into}={}) {return this.act([{type:"type",text,...(into === undefined ? {} : {target:target(into)})}]);}
    clear(value) {return this.act([{type:"clear",target:target(value)}]);}
    navigate(to) {return this.act([{type:"navigate",to}]);}
    launch(packageName) {return this.act([{type:"launch",packageName}]);}
    scroll(value,direction,amount=1) {return this.act([{type:"scroll",target:target(value),direction,amount}]);}
    wake() {return this.act([{type:"wake"}]);}
  }
  globalThis.phone = async query => new Phone(await resolve("phones",query));
})();
`;
