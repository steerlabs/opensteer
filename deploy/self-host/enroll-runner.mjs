// Runs inside the Host container through `docker compose exec`; stdout is the
// enrollment secret, so operator scripts can write it without logging it.
import { randomUUID } from "node:crypto";

const origin = process.env.OPENSTEER_CANONICAL_ORIGIN;
const email = process.env.OPENSTEER_OWNER_EMAIL;
const password = process.env.OPENSTEER_OWNER_PASSWORD;
if (!origin || !email || !password)
  throw new Error("Set the canonical origin and owner credentials");
const base = "http://127.0.0.1:4310";
const discoveryResponse = await fetch(`${base}/.well-known/opensteer`);
if (!discoveryResponse.ok) throw new Error("Host discovery failed");
const { apiVersion } = await discoveryResponse.json();
if (!Number.isSafeInteger(apiVersion)) throw new Error("Host discovery has no API version");
const cookies = new Map();
async function rpc(name, payload) {
  const response = await fetch(`${base}/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opensteer-api-version": String(apiVersion),
      origin,
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const result = await response.json();
  if (!response.ok || result.ok !== true)
    throw new Error(`${name} failed: ${result.error?.message ?? response.status}`);
  return result.data;
}
await rpc("auth.password.signIn", { email, password });
try {
  const enrollment = await rpc("commands.dispatch", {
    allowedModules: ["agents", "browser", "shell"],
    idempotencyKey: `self-host-runner-${randomUUID()}`,
    name: process.env.OPENSTEER_RUNNER_NAME || "Main runner",
    type: "runner.enrollment.createManaged",
  });
  if (typeof enrollment.token !== "string" || !enrollment.token)
    throw new Error("Host returned no Runner enrollment token");
  process.stdout.write(`${enrollment.token}\n`);
} finally {
  await rpc("auth.signOut", {});
}
