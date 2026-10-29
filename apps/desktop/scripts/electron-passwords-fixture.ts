import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export interface FixtureAssertion {
  caseId: string;
  path: string;
  host: string;
  passwordReceived: boolean;
  capturedPassword: boolean;
  authenticated: boolean;
  hooksRan: boolean;
}

/** Owns synthetic values. HTTP evidence records predicates, never request bodies. */
export class PasswordLoginFixture {
  readonly username = "synthetic.person@bank.test";
  readonly password = `synthetic-password-${randomBytes(20).toString("hex")}`;
  readonly totpSeed = randomBytes(20);
  readonly codes = new Set<string>();
  readonly assertions: FixtureAssertion[] = [];
  readonly appAssertions: {
    surface: "phone" | "mac";
    field: string;
    matches: boolean;
    attempts: number;
  }[] = [];
  readonly #sessions = new Map<
    string,
    { identified: boolean; password: boolean; authenticated: boolean }
  >();
  readonly #barriers = new Map<string, ServerResponse>();
  readonly #signals = new Set<string>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #server: Server | undefined;
  #port = 0;
  certificate = "";

  origin(host = "bank.test"): string {
    return `https://${host}:${this.#port}`;
  }

  code(at = Date.now()): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
    const digest = createHmac("sha1", this.totpSeed).update(counter).digest();
    const offset = digest[digest.length - 1]! & 15;
    const code = String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
    this.codes.add(code);
    return code;
  }

  async start(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    const key = path.join(directory, "key.pem");
    const cert = path.join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=bank.test",
        "-addext",
        "subjectAltName=DNS:bank.test,DNS:other.test",
      ],
      { stdio: "ignore" },
    );
    this.certificate = readFileSync(cert, "utf8");
    this.#server = createServer(
      { key: readFileSync(key), cert: this.certificate },
      (request, response) => {
        void this.#handle(request, response).catch(() =>
          response.writeHead(500).end("fixture failure"),
        );
      },
    );
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address.");
    this.#port = address.port;
  }

  signal(id: string): void {
    this.#signals.add(id);
    this.#barriers.get(id)?.end("go");
    this.#barriers.delete(id);
  }

  waiting(id: string): boolean {
    return this.#barriers.has(id);
  }

  async close(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    for (const response of this.#barriers.values()) response.end("stop");
    this.#barriers.clear();
    this.#server?.closeAllConnections();
    if (this.#server) await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin());
    const host = request.headers.host?.split(":")[0] ?? "";
    const caseId = url.searchParams.get("case") ?? "unassigned";
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const params = new URLSearchParams(body);
    const token = /(?:^|;\s*)fixture_session=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1];
    const state = token ? this.#sessions.get(token) : undefined;
    const audit: FixtureAssertion = {
      caseId,
      path: url.pathname,
      host,
      passwordReceived: body.includes(this.password),
      capturedPassword: (params.get("captured") ?? "").includes(this.password),
      authenticated: state?.authenticated === true,
      hooksRan: Number(params.get("hooks")) > 0,
    };
    this.assertions.push(audit);
    response.setHeader("cache-control", "no-store");
    const html = (bodyText: string) =>
      response.writeHead(200, { "content-type": "text/html" }).end(page(bodyText));
    const action = (route: string) => `${route}?case=${encodeURIComponent(caseId)}`;
    const session = () => {
      const id = randomUUID();
      const next = { identified: false, password: false, authenticated: false };
      this.#sessions.set(id, next);
      response.setHeader(
        "set-cookie",
        `fixture_session=${id}; Secure; HttpOnly; SameSite=None; Path=/`,
      );
      return next;
    };
    if (url.pathname === "/account") {
      if (state?.authenticated) {
        audit.authenticated = true;
        html(`<h1>Account</h1><p id="identity">${this.username}</p>`);
      } else
        response
          .writeHead(401, { "content-type": "text/html" })
          .end(page('<h1 id="unauthenticated">Sign in required</h1>'));
      return;
    }
    if (url.pathname === "/login") {
      html(`<h1>Bank sign in</h1><form id="login"><input id="username" name="username" type="email">
<input id="password" name="password" type="password"><button id="submit">Sign in</button></form>
<div id="spinner" hidden>Signing in…</div><main id="next"></main><script>
localStorage.setItem('continuity-local','kept');sessionStorage.setItem('continuity-session','kept');
document.querySelector('#login').onsubmit=async e=>{e.preventDefault();document.querySelector('#spinner').hidden=false;
document.cookie='analytics='+Date.now()+'; Secure; Path=/';
const r=await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('POST',${JSON.stringify(action("/credentials"))});xhr.onload=()=>resolve({ok:xhr.status===200});xhr.send(new URLSearchParams(new FormData(e.target)))});
if(!r.ok) throw Error('fixture credentials refused');document.querySelector('#spinner').hidden=true;e.target.hidden=true;
document.querySelector('#next').innerHTML='<h2 id="chooser">Verify it’s you</h2><label><input id="totp-method" type="radio" name="method">Authenticator app</label><button id="continue">Continue</button>';
document.querySelector('#continue').onclick=()=>{if(document.querySelector('#totp-method').checked)location.href=${JSON.stringify(action("/totp"))}};
};
</script>`);
      return;
    }
    if (url.pathname === "/identifier") {
      html(
        `<h1>Identify account</h1><form method="post" action="${action("/identify")}"><input id="username" name="username" type="email"><button id="submit">Next</button></form>`,
      );
      return;
    }
    if (url.pathname === "/identify" && request.method === "POST") {
      const next = session();
      next.identified = params.get("username") === this.username;
      response.writeHead(next.identified ? 303 : 403, { location: action("/password") }).end();
      return;
    }
    if (url.pathname === "/password") {
      html(
        `<h1>Password</h1><form method="post" action="${action("/identifier-finish")}"><input id="password" name="password" type="password"><button id="submit">Sign in</button></form>`,
      );
      return;
    }
    if (url.pathname === "/identifier-finish" && request.method === "POST") {
      if (state?.identified && params.get("password") === this.password) {
        state.authenticated = true;
        response.writeHead(303, { location: action("/account") }).end();
      } else response.writeHead(403).end("Invalid credentials");
      return;
    }
    if (url.pathname === "/credentials" && request.method === "POST") {
      const next = session();
      next.password =
        params.get("username") === this.username && params.get("password") === this.password;
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        response
          .writeHead(next.password ? 200 : 403)
          .end(next.password ? "verification-required" : "refused");
      }, 1_500);
      this.#timers.add(timer);
      return;
    }
    if (url.pathname === "/totp") {
      html(
        `<h1>Authenticator code</h1><form method="post" action="${action("/verify")}"><input id="code" name="code" type="password" inputmode="numeric"><button id="submit">Verify</button></form>`,
      );
      return;
    }
    if (url.pathname === "/verify" && request.method === "POST") {
      const valid = [this.code(), this.code(Date.now() - 30_000)].includes(
        params.get("code") ?? "",
      );
      if (state?.password && valid) {
        state.authenticated = true;
        response.writeHead(303, { location: action("/account") }).end();
      } else response.writeHead(403).end("Invalid verification");
      return;
    }
    if (url.pathname === "/barrier") {
      const id = url.searchParams.get("id") ?? "";
      response.writeHead(200);
      if (this.#signals.has(id)) response.end("go");
      else this.#barriers.set(id, response);
      return;
    }
    if (url.pathname === "/observe") {
      response.writeHead(200).end("recorded");
      return;
    }
    if (url.pathname === "/parent") {
      html(
        `<h1>Parent site</h1><button id="outside">Focus outside frame</button><iframe id="child" src="${this.origin("other.test")}/frame?case=${caseId}" style="width:500px;height:250px;border:0"></iframe>`,
      );
      return;
    }
    if (url.pathname === "/frame") {
      html(`<form id="fields"><input id="password" name="password" type="password" style="position:absolute;left:20px;top:20px;margin:0"><button id="report" style="position:absolute;left:20px;top:90px;margin:0">Report</button></form><script>
window.__reported=false;document.querySelector('#fields').onsubmit=async e=>{e.preventDefault();await fetch(${JSON.stringify(action("/observe"))},{method:'POST',body:new URLSearchParams(new FormData(e.target))});window.__reported=true};
</script>`);
      return;
    }
    const race = url.searchParams.get("race");
    const id = url.searchParams.get("id");
    const trap = url.searchParams.has("hooks");
    html(`<h1>Fixture field</h1><button id="outside">Non-input</button>
<form id="fields"><input id="password" name="password" type="password"><input id="second" type="password"><input id="username" type="email"><input id="code" type="password"><button id="report">Report observation</button></form>
<script>
window.__documentId=${JSON.stringify(randomUUID())};window.__captures=[];window.__hookCount=0;window.__events={input:0,change:0};
for(const kind of ['input','change'])document.addEventListener(kind,e=>{if(e.bubbles&&e.composed)window.__events[kind]++});
document.querySelector('#fields').onsubmit=async e=>{e.preventDefault();const data=new URLSearchParams(new FormData(e.target));
data.set('captured',window.__captures.join('\\n'));data.set('hooks',window.__hookCount);await fetch(${JSON.stringify(action("/observe"))},{method:'POST',body:data});window.__reported=true};
${trap ? accessorTrap : ""}
${race && id ? `if(!sessionStorage.getItem('race-${id}')){sessionStorage.setItem('race-${id}','armed');fetch('/barrier?id=${encodeURIComponent(id)}').then(r=>r.text()).then(()=>{${race === "reload" ? "location.reload()" : race === "focus" ? "document.querySelector('#second').focus();window.__raceDone=true" : race === "leave-frame" ? "document.querySelector('#outside').focus();window.__raceDone=true" : `location.href=${JSON.stringify(action("/replacement"))}`}})}` : ""}
</script>`);
  }
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;margin:20px}input,button{display:block;width:280px;height:30px;margin:10px 0}#spinner{position:fixed;inset:0;background:white;z-index:1000;padding:80px}#spinner[hidden]{display:none}</style></head><body>${body}</body></html>`;
}

const accessorTrap = `
Error.prepareStackTrace=(_error,frames)=>{window.__hookCount++;for(const frame of frames){try{const fn=frame.getFunction();if(fn)window.__captures.push(Function.prototype.toString.call(fn))}catch{}}return 'fixture-stack'};
const active=Object.getOwnPropertyDescriptor(Document.prototype,'activeElement');
Object.defineProperty(Document.prototype,'activeElement',{configurable:true,get(){void new Error().stack;return active.get.call(this)}});
const value=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
Object.defineProperty(HTMLInputElement.prototype,'value',{configurable:true,set:value.set,get(){void new Error().stack;const result=value.get.call(this);window.__captures.push(result);return result}});
`;
