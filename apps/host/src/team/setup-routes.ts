import { randomBytes } from "node:crypto";
import {
  HostAccountIdentitySchema,
  HostAccountAdoptionBundleSchema,
  HostAccountAdoptionCompletionGrantSchema,
} from "@opensteer/control-plane-protocol";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import type { IdentityService } from "@opensteer/identity";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { assertTeamApiVersion } from "./services.js";

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
  options: { identity: IdentityService; accountPortalOrigin: string },
) {
  const gate = (request: FastifyRequest) => assertTeamApiVersion(headers(request));
  app.get("/setup", async (_request, reply) => {
    const nonce = randomBytes(18).toString("base64url");
    return reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      )
      .type("text/html")
      .send(teamSetupPage(nonce, options.accountPortalOrigin));
  });
  app.get("/invite/:selector", async (request, reply) => {
    const { selector } = z
      .strictObject({ selector: z.string().regex(/^[A-Za-z0-9_-]{32}$/) })
      .parse(request.params);
    const nonce = randomBytes(18).toString("base64url");
    return reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      )
      .type("text/html")
      .send(teamSetupPage(nonce, options.accountPortalOrigin, selector));
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
  app.post("/v1/team/setup/adoption/proof", { onRequest: gate }, async (request, reply) => {
    const account = HostAccountIdentitySchema.parse(request.body);
    const proof = await options.identity.issueSetupAccountAdoptionProof(headers(request), account);
    void reply.header("cache-control", "no-store");
    return { ...proof, authority: proof.deployment, expiresAt: proof.expiresAt.toISOString() };
  });
  app.post("/v1/team/setup/adoption/complete", { onRequest: gate }, async (request, reply) => {
    const input = z
      .strictObject({
        grant: HostAccountAdoptionCompletionGrantSchema,
        bundle: HostAccountAdoptionBundleSchema,
      })
      .parse(request.body);
    void reply.header("cache-control", "no-store");
    return options.identity.completeTeamAccountAdoption(input.grant, input.bundle);
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
function teamSetupPage(
  nonce: string,
  accountPortalOrigin: string,
  inviteSelector: string | null = null,
) {
  const portal = new URL(accountPortalOrigin).origin;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up your team · Opensteer</title><style>body{font:16px system-ui;margin:12vh auto;padding:24px;max-width:440px;color:#25231f;background:#faf9f6}h1{font-weight:600}button{font:inherit;padding:12px 18px;border-radius:10px;border:1px solid #d6d2ca;background:#fff;cursor:pointer}p{line-height:1.5}</style><h1>Set up your team</h1><p id="status">Checking setup…</p><button id="continue" hidden>Continue with Opensteer Account</button><script nonce="${nonce}">
  const verifier=location.hash.slice(1);history.replaceState(null,'',location.pathname);
  const invitation=${JSON.stringify(inviteSelector)};
  const status=document.getElementById('status'),button=document.getElementById('continue');
  const portal=${JSON.stringify(portal)},versionHeaders={${JSON.stringify(teamApiVersionHeader)}:${JSON.stringify(String(teamApiVersion))}};
  const post=async(path,input)=>{const r=await fetch(path,{method:'POST',headers:{...versionHeaders,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error'});if(!r.ok)throw new Error('Setup could not continue. Re-run the team setup script for a new link.');return r.json();};
  let popup=null,nonce=null,ready=false;
  const initialize=async()=>{try{if(verifier)await post(invitation?'/v1/team/invites/exchange':'/v1/team/setup/exchange',invitation?{selector:invitation,verifier}:{token:verifier});const state=await(await fetch('/v1/team/setup/state',{headers:versionHeaders})).json();if(state.complete&&!invitation){location.replace('/');return;}ready=state.accountReady;if(invitation)document.querySelector('h1').textContent='Join your team';status.textContent='Your team uses Opensteer Account to sign in. Your own agent and files stay on your computer.';button.hidden=false;}catch(error){status.textContent=error.message;}};
  button.onclick=async()=>{if(ready){try{const result=await post('/v1/team/setup/sign-in',{});location.assign(result.redirectUrl);}catch(error){status.textContent=error.message;}return;}nonce=crypto.randomUUID();const url=new URL('/team-setup',portal);url.searchParams.set('origin',location.origin);url.searchParams.set('nonce',nonce);popup=window.open(url.href,'opensteer-team-setup','popup,width=520,height=720');if(!popup)status.textContent='Allow this popup to continue with Opensteer Account.';};
  window.addEventListener('message',async(event)=>{if(event.source!==popup||event.origin!==portal||event.data?.nonce!==nonce)return;try{if(event.data.type==='team-setup.account'){const proof=await post('/v1/team/setup/adoption/proof',event.data.account);popup.postMessage({type:'team-setup.proof',nonce,proof},portal);}else if(event.data.type==='team-setup.completed'){popup.close();ready=true;status.textContent='Your team is connected. Sign in to become its first owner.';button.textContent='Sign in and create team';}}catch(error){status.textContent=error.message;}});
  initialize();</script></html>`;
}
