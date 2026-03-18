import { Opensteer } from "opensteer";

async function main(): Promise<void> {
  const opensteer = new Opensteer({
    name: "browser-backed-replay-example",
    rootDir: process.cwd(),
    browser: { headless: true },
  });

  try {
    await opensteer.open("https://example.com");

    const token = await opensteer.evaluate<string>({
      script: "() => window.exampleToken ?? \"\"",
    });

    const response = await opensteer.rawRequest({
      transport: "context-http",
      url: "https://example.com/api/items",
      method: "POST",
      body: {
        json: { token },
      },
    });

    console.log(response.data);
  } finally {
    await opensteer.close();
  }
}

void main();
