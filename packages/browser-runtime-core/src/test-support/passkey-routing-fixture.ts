import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:https";
import { z } from "zod";
import { verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { key, cert } from "./fixtures/passkey-provider-tls.js";

/** A synthetic RP verifies bytes independently of the provider and the relays. */
export async function servePasskeyRoutingFixture() {
  const challenge = randomBytes(32).toString("base64url");
  const creation = {
    rp: { name: "Example relying party" },
    user: { id: "AQID", name: "person@example.test", displayName: "Example Person" },
    challenge,
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  };
  let origin = "";
  let saved:
    | NonNullable<
        Awaited<ReturnType<typeof verifyRegistrationResponse>>["registrationInfo"]
      >["credential"]
    | undefined;
  const verified = { registrations: 0, assertions: 0 };
  const responseBase = {
    id: z.string(),
    rawId: z.string(),
    type: z.literal("public-key"),
    clientExtensionResults: z.object({}),
  };
  const registration = z.object({
    ...responseBase,
    response: z.object({
      clientDataJSON: z.string(),
      attestationObject: z.string(),
    }),
  });
  const authentication = z.object({
    ...responseBase,
    response: z.object({
      clientDataJSON: z.string(),
      authenticatorData: z.string(),
      signature: z.string(),
      userHandle: z.string(),
    }),
  });
  const server = createServer({ key, cert }, (request, response) => {
    void (async () => {
      if (request.url === "/register" || request.url === "/authenticate") {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          assert(body.length < 131_072, "Bounded RP response");
        }
        const expected = {
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: "rp.example.test",
          requireUserVerification: true,
        };
        const input: unknown = JSON.parse(body);
        if (request.url === "/register") {
          const result = await verifyRegistrationResponse({
            ...expected,
            response: registration.parse(input),
          });
          assert(result.verified && result.registrationInfo);
          saved = result.registrationInfo.credential;
          verified.registrations++;
        } else {
          assert(saved);
          const result = await verifyAuthenticationResponse({
            ...expected,
            response: authentication.parse(input),
            credential: saved,
          });
          assert(result.verified);
          verified.assertions++;
        }
        response.end(JSON.stringify({ verified: true }));
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Example passkeys</title><button id="create">Create</button><button id="get">Sign in</button><script>
const creation = ${JSON.stringify(creation)};
window.runCeremony = async (op, mode = "normal") => {
  const started = performance.now(); let timer;
  const operation = async () => {
    const options = op === "create"
      ? PublicKeyCredential.parseCreationOptionsFromJSON({...creation, ...(mode === "exclude" ? {excludeCredentials:[{type:"public-key",id:window.credentialId}]} : {})})
      : PublicKeyCredential.parseRequestOptionsFromJSON({challenge:creation.challenge, allowCredentials:[{type:"public-key",id: mode === "missing" ? "BAUG" : window.credentialId}]});
    const credential = await navigator.credentials[op]({publicKey:options});
    if(op === "create") window.credentialId = credential.id;
    const reply = await fetch(op === "create" ? "/register" : "/authenticate", {method:"POST",body:JSON.stringify(credential)});
    if(!reply.ok || !(await reply.json()).verified) throw new Error("RP verification failed");
    return "verified";
  };
  try {
    const outcome = await Promise.race([operation(), new Promise(resolve => {timer=setTimeout(()=>resolve("pending"),4000);})]);
    return {outcome, ms:Math.round(performance.now()-started)};
  } catch(error) { return {outcome:error.name, ms:Math.round(performance.now()-started)}; }
  finally {clearTimeout(timer);}
};
for(const op of ["create","get"]) document.getElementById(op).onclick=()=>{window.result=window.runCeremony(op, window.ceremonyMode ?? "normal");};
${request.url === "/offer" ? `window.result=window.runCeremony("create");` : ""}
${request.url === "/probe" ? `navigator.credentials.get({publicKey:{challenge:new Uint8Array([1])}}).then(()=>parent.postMessage("resolved","*"),e=>parent.postMessage(e.name,"*"));` : ""}
</script>`);
    })().catch(() => response.writeHead(500).end("RP verification failed"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  origin = `https://rp.example.test:${address.port}`;
  return {
    origin,
    crossOrigin: `https://other.example.test:${address.port}`,
    verified,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
