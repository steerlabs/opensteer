import { randomBytes } from "node:crypto";
import { teamAppScheme, teamNativeAuthorizePath } from "@opensteer/core";
import {
  CompleteTeamSetupAdoptionRequestSchema,
  CompleteTeamSetupAdoptionResponseSchema,
  HostAccountIdentitySchema,
  HostedTeamOwnerCheckRequestSchema,
  HostedTeamOwnerCheckResponseSchema,
  IssueHostAccountAdoptionProofResponseSchema,
  teamSetupPaths,
} from "@opensteer/control-plane-protocol";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import type { IdentityService, TeamIdentityAdmission } from "@opensteer/identity";
import type { TeamInvitesStore } from "@opensteer/database/team-invites";
import {
  TeamInvitePreviewRequestSchema,
  TeamInvitePreviewResponseSchema,
  teamInvitePreviewPath,
} from "@opensteer/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { assertTeamApiVersion } from "./services.js";

/** Pages the team Host serves itself; its gateway must route them here, not to the web app. */
export const teamSetupPagePath = "/setup";
export const teamInvitePagePrefix = "/invite/";

function headers(request: FastifyRequest) {
  const result = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) result.append(key, item);
    else if (value !== undefined) result.set(key, value);
  }
  return result;
}
export function registerTeamSetupRoutes(
  app: FastifyInstance,
  options: {
    identity: IdentityService;
    invites: TeamInvitesStore;
    teamName: string;
    accountPortalOrigin: string;
    /** Answers Account's hosted-team owner checks; absent on a Host without hosted bootstrap. */
    hosted?: Pick<TeamIdentityAdmission, "isOwner">;
  },
) {
  const gate = async (request: FastifyRequest) => assertTeamApiVersion(headers(request));
  const page = (reply: FastifyReply, render: (nonce: string) => string) => {
    const nonce = randomBytes(18).toString("base64url");
    return reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      )
      .type("text/html")
      .send(render(nonce));
  };
  app.get(teamSetupPagePath, async (_request, reply) =>
    page(reply, (nonce) => teamSetupPage(nonce, options.accountPortalOrigin)),
  );
  app.get(`${teamInvitePagePrefix}:selector`, async (request, reply) => {
    z.strictObject({ selector: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).parse(request.params);
    return page(reply, teamInvitePage);
  });
  app.post(teamInvitePreviewPath, { onRequest: gate }, async (request, reply) => {
    const { expiresAt } = await options.invites.preview(
      TeamInvitePreviewRequestSchema.parse(request.body),
    );
    void reply.header("cache-control", "no-store");
    return TeamInvitePreviewResponseSchema.parse({ teamName: options.teamName, expiresAt });
  });
  app.post("/v1/team/invites/exchange", { onRequest: gate }, async (request, reply) => {
    const input = z
      .strictObject({
        selector: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
        verifier: z.string().min(24).max(256),
      })
      .parse(request.body);
    const result = await options.identity.exchangeTeamInvitation(
      input.selector,
      input.verifier,
      headers(request),
    );
    for (const cookie of result.headers.getSetCookie()) void reply.header("set-cookie", cookie);
    void reply.header("cache-control", "no-store");
    return { admitted: true };
  });
  app.get("/v1/team/setup/state", { onRequest: gate }, async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    const config = await options.identity.configuration();
    return {
      complete: config.setupState === "complete",
      accountReady: config.oidcProviders.length > 0,
    };
  });
  app.post("/v1/team/setup/exchange", { onRequest: gate }, async (request, reply) => {
    const input = z.strictObject({ token: z.string().min(24).max(256) }).parse(request.body);
    const result = await options.identity.exchangeInitialOwnerEnrollment(
      input.token,
      headers(request),
    );
    for (const cookie of result.headers.getSetCookie()) void reply.header("set-cookie", cookie);
    void reply.header("cache-control", "no-store");
    return result.data;
  });
  app.post(teamSetupPaths.adoptionProof, { onRequest: gate }, async (request, reply) => {
    const account = HostAccountIdentitySchema.parse(request.body);
    const proof = await options.identity.issueSetupAccountAdoptionProof(headers(request), account);
    void reply.header("cache-control", "no-store");
    return IssueHostAccountAdoptionProofResponseSchema.parse({
      proofId: proof.proofId,
      proofCredential: proof.proofCredential,
      account: proof.account,
      authority: proof.deployment,
      expiresAt: proof.expiresAt.toISOString(),
    });
  });
  app.post(teamSetupPaths.adoptionComplete, { onRequest: gate }, async (request, reply) => {
    const input = CompleteTeamSetupAdoptionRequestSchema.parse(request.body);
    void reply.header("cache-control", "no-store");
    return CompleteTeamSetupAdoptionResponseSchema.parse(
      await options.identity.completeTeamAccountAdoption(
        input.grant,
        input.bundle,
        input.hostedBootstrap,
      ),
    );
  });
  const hosted = options.hosted;
  if (hosted)
    app.post(teamSetupPaths.ownerCheck, { onRequest: gate }, async (request, reply) => {
      const input = HostedTeamOwnerCheckRequestSchema.parse(request.body);
      void reply.header("cache-control", "no-store");
      return HostedTeamOwnerCheckResponseSchema.parse({
        owner: await hosted.isOwner(input.assertion),
      });
    });
  app.post("/v1/team/setup/sign-in", { onRequest: gate }, async (request, reply) => {
    const result = await options.identity.beginOidcSignIn({
      headers: headers(request),
      providerId: "opensteer-account",
      returnPath: "/",
    });
    for (const cookie of result.headers.getSetCookie()) void reply.header("set-cookie", cookie);
    void reply.header("cache-control", "no-store");
    return result.data;
  });
}
function teamSetupPage(nonce: string, accountPortalOrigin: string) {
  const portal = new URL(accountPortalOrigin).origin;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up your team · Opensteer</title><style>body{font:16px system-ui;margin:12vh auto;padding:24px;max-width:440px;color:#25231f;background:#faf9f6}h1{font-weight:600}button{font:inherit;padding:12px 18px;border-radius:10px;border:1px solid #d6d2ca;background:#fff;cursor:pointer}p{line-height:1.5}</style><h1>Set up your team</h1><p id="status">Checking setup…</p><button id="continue" hidden>Continue with Opensteer Account</button><script nonce="${nonce}">
  const verifier=location.hash.slice(1);history.replaceState(null,'',location.pathname);
  const status=document.getElementById('status'),button=document.getElementById('continue');
  const portal=${JSON.stringify(portal)},versionHeaders=${versionHeaders()};
  const post=async(path,input)=>{const r=await fetch(path,{method:'POST',headers:{...versionHeaders,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error'});if(!r.ok)throw new Error('Setup could not continue. Re-run the team setup script for a new link.');return r.json();};
  let popup=null,nonce=null,ready=false;
  const initialize=async()=>{try{if(verifier)await post('/v1/team/setup/exchange',{token:verifier});const state=await(await fetch('/v1/team/setup/state',{headers:versionHeaders})).json();if(state.complete){location.replace('/');return;}ready=state.accountReady;status.textContent='Your team uses Opensteer Account to sign in. Your own agent and files stay on your computer.';button.hidden=false;}catch(error){status.textContent=error.message;}};
  button.onclick=async()=>{if(ready){try{const result=await post('/v1/team/setup/sign-in',{});location.assign(result.redirectUrl);}catch(error){status.textContent=error.message;}return;}nonce=crypto.randomUUID();const url=new URL('/team-setup',portal);url.searchParams.set('origin',location.origin);url.searchParams.set('nonce',nonce);popup=window.open(url.href,'opensteer-team-setup','popup,width=520,height=720');if(!popup)status.textContent='Allow this popup to continue with Opensteer Account.';};
  window.addEventListener('message',async(event)=>{if(event.source!==popup||event.origin!==portal||event.data?.nonce!==nonce)return;try{if(event.data.type==='team-setup.account'){const proof=await post('/v1/team/setup/adoption/proof',event.data.account);popup.postMessage({type:'team-setup.proof',nonce,proof},portal);}else if(event.data.type==='team-setup.completed'){popup.close();ready=true;status.textContent='Your team is connected. Sign in to become its first owner.';button.textContent='Sign in and create team';}}catch(error){status.textContent=error.message;}});
  initialize();</script></html>`;
}
function versionHeaders() {
  return JSON.stringify({ [teamApiVersionHeader]: String(teamApiVersion) });
}
const downloadUrl = "https://opensteer.com/download";
/**
 * The page an invite link opens. The verifier lives only in the fragment: the script reads it,
 * drops it from history and sends it only in request bodies. Nothing here names who invited.
 * With `?authorize=` (the app's sign-in, `teamInviteSignInUrl`), it proves the invite in this
 * browser and continues to that native sign-in on this origin, so its callback admits the person.
 */
function teamInvitePage(nonce: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>Join your team · Opensteer</title><style>
:root{--bg:#0f0f10;--card:#17171a;--line:#2a2a2f;--edge:#34343a;--text:#ececee;--muted:#b0b0b7;--quiet:#9b9ba3;--accent:#e8a68b;--on-accent:#1a120e;--mark:#3a2c55}
@media (prefers-color-scheme:light){:root{--bg:#faf9f6;--card:#fff;--line:#e6e2da;--edge:#d6d2ca;--text:#25231f;--muted:#5f5b53;--quiet:#77726a;--accent:#c4704f;--on-accent:#fff;--mark:#e4dcf2}}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{font:16px/1.5 Inter,system-ui,-apple-system,sans-serif;color:var(--text);background:var(--bg);min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px max(16px,env(safe-area-inset-right)) 24px max(16px,env(safe-area-inset-left))}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:16px;text-align:center;align-items:center}
main[hidden],[hidden]{display:none}
.mark{width:56px;height:56px;border-radius:14px;background:var(--mark);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px}
h1{margin:0;font-size:22px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}p{margin:0;color:var(--muted)}.small{font-size:13px;color:var(--quiet)}
a{color:var(--accent)}
.button{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;border-radius:10px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;border:0;background:var(--accent);color:var(--on-accent)}
.button.secondary{background:transparent;color:var(--text);border:1px solid var(--edge);font-weight:500}
.button:disabled{opacity:.6;cursor:default}.text{background:none;border:0;padding:8px;font:inherit;font-size:13px;color:var(--quiet);text-decoration:underline;cursor:pointer;min-height:44px}
</style>
<main id="checking"><p id="checking-text">Checking your invite…</p></main>
<main id="refused" hidden><h1 id="refused-title">This invite doesn't work</h1><p>Ask whoever invited you for a new link.</p></main>
<main id="start" hidden><div class="mark" id="mark" aria-hidden="true"></div><h1 id="invited"></h1><p>Team chat where everyone can ask their own agent. Your agent runs on your computer and only acts when you ask.</p><a class="button" id="open-app">Open in Opensteer</a><button class="button secondary" id="web" type="button">Join in the browser</button><p class="small">Don't have Opensteer? <a href="${downloadUrl}">Download it</a> to bring your agent.</p></main>
<main id="opening" hidden><h1>Opening Opensteer…</h1><p>Finish joining in the app. Nothing happened? <a href="${downloadUrl}">Download Opensteer</a> or join in the browser.</p><button class="text" type="button" data-back>Back</button></main>
<main id="joining" hidden><h1 id="join-title"></h1><p>Sign in with your Opensteer Account to join. You can chat here right away; open the Opensteer app later to bring your agent.</p><button class="button" id="sign-in" type="button">Continue with Opensteer Account</button><p class="small" id="join-error" role="alert" hidden></p><button class="text" type="button" data-back>Back</button></main>
<script nonce="${nonce}">
const verifier=location.hash.slice(1),selector=location.pathname.split('/').pop(),authorize=new URLSearchParams(location.search).get('authorize');history.replaceState(null,'',location.pathname);
const versionHeaders=${versionHeaders()},el=(id)=>document.getElementById(id);
const show=(id)=>{for(const main of document.querySelectorAll('main'))main.hidden=main.id!==id;};
const post=async(path,input)=>{const r=await fetch(path,{method:'POST',headers:{...versionHeaders,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error'});const body=await r.json().catch(()=>null);if(!r.ok)throw Object.assign(new Error(body?.message??'Something went wrong. Try again.'),{reason:body?.reason});return body;};
const refuse=(reason)=>{el('refused-title').textContent=reason==='invite-expired'?'This invite has expired':reason==='invite-used-up'?'This invite has been used up':reason==='missing'?'Open your invite link again':"This invite doesn't work";show('refused');};
const mobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)||(navigator.maxTouchPoints>1&&/Macintosh/.test(navigator.userAgent));
el('open-app').href=(mobile?${JSON.stringify(teamAppScheme("mobile"))}:${JSON.stringify(teamAppScheme("desktop"))})+':/team?'+new URLSearchParams({url:location.origin+location.pathname+'#'+verifier});
el('open-app').onclick=()=>show('opening');
el('web').onclick=()=>show('joining');
for(const back of document.querySelectorAll('[data-back]'))back.onclick=()=>show('start');
el('sign-in').onclick=async()=>{const button=el('sign-in'),error=el('join-error');button.disabled=true;error.hidden=true;try{await post('/v1/team/invites/exchange',{selector,verifier});const result=await post('/v1/team/setup/sign-in',{});location.assign(result.redirectUrl);}catch(e){if(e.reason&&e.reason.startsWith('invite-'))return refuse(e.reason);error.textContent=e.message;error.hidden=false;button.disabled=false;}};
(async()=>{if(!/^[A-Za-z0-9_-]{24,128}$/.test(verifier))return refuse('missing');if(authorize!==null){try{await post('/v1/team/invites/exchange',{selector,verifier});location.replace(${JSON.stringify(teamNativeAuthorizePath)}+'?'+authorize);}catch(e){if(e.reason&&e.reason.startsWith('invite-'))return refuse(e.reason);el('checking-text').textContent=e.message;}return;}try{const invite=await post(${JSON.stringify(teamInvitePreviewPath)},{selector,verifier});el('mark').textContent=[...invite.teamName.trim()][0]?.toUpperCase()??'';el('invited').textContent='You\u2019re invited to '+invite.teamName;el('join-title').textContent='Join '+invite.teamName;document.title='Join '+invite.teamName+' \u00b7 Opensteer';show('start');}catch(e){refuse(e.reason);}})();
</script></html>`;
}
