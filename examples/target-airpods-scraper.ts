import { Opensteer } from "../packages/opensteer/src/index.js";

async function main(): Promise<void> {
  const opensteer = new Opensteer({
    name: "target-airpods",
    rootDir: process.cwd(),
    browser: {
      headless: false,
    },
  });

  try {
    await opensteer.open("https://www.target.com");
    console.log("Opened target.com");

    // Replay cached "target search box" descriptor
    await opensteer.input({
      description: "target search box",
      text: "airpods",
      pressEnter: true,
    });
    console.log("Searched for airpods");

    // Navigate to ensure fresh document refs after form submission
    await delay(2000);
    await opensteer.goto("https://www.target.com/s?searchTerm=airpods");
    await delay(2000);

    // Replay cached "airpods product list" descriptor
    const data = await opensteer.extract({
      description: "airpods product list",
    });
    console.log(JSON.stringify(data, null, 2));
  } finally {
    await opensteer.close();
    console.log("Browser closed.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
