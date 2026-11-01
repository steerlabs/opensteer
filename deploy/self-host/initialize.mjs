import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
const dir = "deploy/self-host";
fs.mkdirSync(`${dir}/secrets`, { recursive: true, mode: 0o700 });
fs.chmodSync(`${dir}/secrets`, 0o700);
const secret = (name, value) => {
  const path = `${dir}/secrets/${name}`;
  try {
    fs.writeFileSync(path, `${value}\n`, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const saved = fs.readFileSync(path, "utf8").trim();
  if (!saved) throw new Error(`${name} is empty`);
  return saved;
};
const password = secret("postgres_password", randomBytes(32).toString("base64url"));
for (const name of [
  "browser_bridge_token",
  "browser_runner_enrollment_token",
  "messaging_runner_enrollment_token",
  "opensteer_auth_secret",
  "initial_owner_enrollment_token",
])
  secret(name, randomBytes(48).toString("base64url"));
for (const name of ["credential_key"]) secret(name, randomBytes(32).toString("base64url"));
const url = `postgres://opensteer:${encodeURIComponent(password)}@postgres:5432/opensteer`;
if (secret("database_url", url) !== url)
  throw new Error("database_url disagrees with postgres_password");
let config = fs.readFileSync(`${dir}/config.env`, "utf8");
const values = {
  OPENSTEER_RELEASE_VERSION: JSON.parse(fs.readFileSync("package.json")).version,
  OPENSTEER_SOURCE_REVISION: process.env.OPENSTEER_SOURCE_REVISION,
};
for (const [key, value] of Object.entries(values))
  config = config.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
config = config.replace("replace-with-a-generated-environment-id", `env_${randomUUID()}`);
fs.writeFileSync(`${dir}/config.env`, config, { mode: 0o600 });
