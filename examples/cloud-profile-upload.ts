import { OpensteerCloudClient } from "../packages/opensteer/src/index.js";

async function main(): Promise<void> {
  const apiKey = process.env.OPENSTEER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENSTEER_API_KEY is required.");
  }

  const client = new OpensteerCloudClient({
    apiKey,
    baseUrl: process.env.OPENSTEER_BASE_URL ?? "https://api.opensteer.dev",
  });

  const result = await client.uploadLocalBrowserProfile({
    profileId: "bp_123",
    fromUserDataDir: "~/Library/Application Support/Google/Chrome",
    profileDirectory: "Default",
  });

  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
