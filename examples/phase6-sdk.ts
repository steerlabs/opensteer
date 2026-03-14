import { Opensteer } from "../packages/opensteer/src/index.js";

async function main(): Promise<void> {
  const opensteer = new Opensteer({
    name: "phase6-example",
    rootDir: process.cwd(),
    browser: {
      headless: true,
    },
  });

  try {
    await opensteer.open("https://example.com");

    const actionSnapshot = await opensteer.snapshot("action");
    const firstLink = actionSnapshot.counters.find((counter) => counter.tagName === "A");
    if (firstLink) {
      await opensteer.hover({
        element: firstLink.element,
      });
    }

    const extracted = await opensteer.extract({
      description: "example page",
      schema: {
        url: { source: "current_url" },
        heading: { selector: "h1" },
        links: [
          {
            text: { selector: "a:nth-of-type(1)" },
            href: { selector: "a:nth-of-type(1)", attribute: "href" },
          },
        ],
      },
    });

    process.stdout.write(`${JSON.stringify({ actionSnapshot, extracted }, null, 2)}\n`);
  } finally {
    await opensteer.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
