import { expect, it } from "vitest";
import { startUpstream } from "./integration-schemas.test-support.js";

it("keeps upstream admission assertions exact when localhost probes arrive", async () => {
  const upstream = await startUpstream("{}", "https://provider.test", "refused");
  try {
    expect(upstream.received).toEqual([]);
    await upstream.fetch("https://provider.test/assistant", { method: "POST", body: "{}" });
    await upstream.fetch("https://provider.test/assistant/id");
    expect(upstream.received).toEqual([
      { method: "POST", url: "/assistant", body: "{}", contentType: "text/plain;charset=UTF-8" },
      { method: "GET", url: "/assistant/id", body: "", contentType: null },
    ]);
  } finally {
    await upstream.close();
  }
});
