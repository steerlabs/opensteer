import { randomBytes } from "node:crypto";
import { createPublicHttpsFetch } from "@opensteer/access/host";
import {
  AdoptExistingDeploymentRequestSchema,
  HostAccountIdentitySchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BrowserPageFonts } from "@opensteer/shared/browserPage";
import { z } from "zod";
import type { ControlPlaneStore } from "../database/store.js";
import type { PortalSession } from "../portal/portal-sessions.js";
import { requireExactOrigin } from "../portal/browser-http.js";
import { browserPagePolicyWithScript, sendBrowserPage } from "../portal/pages.js";
import { ControlPlaneError } from "../server/errors.js";

const querySchema = z.strictObject({
  origin: z
    .url()
    .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value),
  nonce: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$|^[0-9a-f-]{36}$/),
});
export function registerTeamSetupPortal(
  app: FastifyInstance,
  options: {
    store: ControlPlaneStore;
    publicOrigin: URL;
    portalOrigin: URL;
    fonts: BrowserPageFonts | undefined;
    guard: (request: FastifyRequest) => void;
    readSession: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<PortalSession | undefined>;
    fetch?: typeof globalThis.fetch;
  },
) {
  const fetch =
    options.fetch ?? createPublicHttpsFetch({ maxResponseBytes: 64 * 1024, timeoutMs: 10000 });
  app.get("/team-setup", async (request, reply) => {
    options.guard(request);
    const query = querySchema.parse(request.query);
    const session = await options.readSession(request, reply);
    if (!session)
      return reply.redirect(`/auth/sign-in?${new URLSearchParams({ return: request.url })}`, 303);
    const nonce = randomBytes(18).toString("base64url");
    const account = HostAccountIdentitySchema.parse({
      issuer: options.publicOrigin.origin,
      subject: session.accountId,
    });
    const parameters = JSON.stringify({
      origin: query.origin,
      nonce: query.nonce,
      account,
    }).replace(/</g, "\\u003c");
    return sendBrowserPage(reply, {
      title: "Create your team · Opensteer",
      fonts: options.fonts,
      layout: "card",
      policy: browserPagePolicyWithScript(nonce, ["connect-src 'self'"]),
      body: `<h1 class="title">Create your team</h1><p>Connect this team to your Opensteer Account, then sign in there to become its first owner.</p><button id="create" disabled>Create team</button><p id="state"></p><script nonce="${nonce}">
      const p=${parameters};let proof=null;const parent=window.opener,button=document.getElementById('create'),state=document.getElementById('state');
      window.addEventListener('message',(event)=>{if(event.source!==parent||event.origin!==p.origin||event.data?.nonce!==p.nonce||event.data.type!=='team-setup.proof')return;proof=event.data.proof;button.disabled=false;});
      button.onclick=async()=>{if(!proof)return;button.disabled=true;try{const r=await fetch('/team-setup/adopt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'My team',reachability:'canonical',authority:proof.authority,proof:{proofId:proof.proofId,proofCredential:proof.proofCredential}}),redirect:'error'});if(!r.ok)throw new Error();parent.postMessage({type:'team-setup.completed',nonce:p.nonce},p.origin);state.textContent='Connected. Return to your team to sign in.';}catch{state.textContent='Setup did not finish. Return to your team and try again.';button.disabled=false;}};
      if(parent)parent.postMessage({type:'team-setup.account',nonce:p.nonce,account:p.account},p.origin);else state.textContent='Open the setup link printed by your team server.';
    </script>`,
    });
  });
  app.post("/team-setup/adopt", async (request, reply) => {
    options.guard(request);
    requireExactOrigin(request, options.portalOrigin.origin);
    const session = await options.readSession(request, reply);
    if (!session) throw new ControlPlaneError("unauthorized", "Account sign-in required");
    const input = AdoptExistingDeploymentRequestSchema.parse(request.body);
    const result = await options.store.adoptExistingDeployment(
      session.accountId as ControlPlaneAccountId,
      input,
    );
    const response = await fetch(
      new URL("/v1/team/setup/adoption/complete", input.authority.canonicalOrigin),
      {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          "content-type": "application/json",
          [teamApiVersionHeader]: String(teamApiVersion),
        },
        body: JSON.stringify({ grant: result.completionGrant, bundle: result.provisioningBundle }),
      },
    );
    if (!response.ok)
      throw new ControlPlaneError("conflict", "The team did not finish Account setup; try again");
    void reply.header("cache-control", "no-store");
    return { completed: true };
  });
}
