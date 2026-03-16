import { OpensteerSessionRuntime } from "./packages/opensteer/src/sdk/runtime.js";

async function main() {
  const runtime = new OpensteerSessionRuntime({
    name: "debug-final",
    browser: { headless: false },
  });
  try {
    await runtime.open({ url: "https://www.maersk.com/tracking/" });
    await new Promise(r => setTimeout(r, 5000));
    const result = await runtime.snapshot({ mode: "action" });
    console.log("Result HTML length:", result.html.length);
    console.log("Result counters:", result.counters.length);
    console.log("Files saved to /tmp/debug-*.html");
  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await runtime.close();
  }
}
main().catch(console.error);
