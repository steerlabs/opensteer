import { Opensteer } from "../packages/opensteer/src/index.js";

async function main(): Promise<void> {
  const opensteer = Opensteer.attach({
    name: "docs-example",
    rootDir: process.cwd(),
  });

  try {
    const state = await opensteer.open();
    console.log(`Attached to ${state.url}`);

    const snapshot = await opensteer.snapshot("action");
    console.log(`Found ${snapshot.counters.length} interactive targets`);
  } finally {
    await opensteer.disconnect();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

