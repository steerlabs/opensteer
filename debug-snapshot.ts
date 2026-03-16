import { Opensteer } from "./packages/opensteer/src/sdk/opensteer.js";

async function main() {
  const os = new Opensteer({
    name: "debug",
    browser: { headless: false },
  });

  try {
    console.log("Opening browser...");
    await os.open("https://www.maersk.com/tracking/");

    // Wait for page to fully load
    console.log("Waiting 5s for page to settle...");
    await new Promise(r => setTimeout(r, 5000));

    console.log("Taking snapshot...");
    const result = await os.snapshot({ mode: "action" });

    console.log("\n=== SNAPSHOT RESULT ===");
    console.log("URL:", result.url);
    console.log("Title:", result.title);
    console.log("HTML length:", result.html.length);
    console.log("Counter count:", result.counters.length);
    console.log("\nHTML (first 2000 chars):", result.html.slice(0, 2000));
    console.log("\nCounters:", JSON.stringify(result.counters.slice(0, 5), null, 2));
  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await os.close();
  }
}

main();
