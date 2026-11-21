// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountOffer, offerLine, offeredPlan } from "./offer.js";

const today = "Paid monthly · cancel any time";
const plan = { name: "Cloud Computer", currency: "usd", amountMinor: 2900, interval: "month" };
afterEach(() => vi.unstubAllGlobals());

function card(url = "https://app.opensteer.com/v1/cloud-computers/offer") {
  const line = document.createElement("p");
  line.dataset["offer"] = url;
  line.textContent = today;
  return line;
}

describe("the website's Cloud Computer price", () => {
  it("is the account service's plan in the account page's own words", () => {
    expect(offeredPlan({ plan })).toEqual({
      amountMinor: 2900,
      currency: "usd",
      interval: "month",
    });
    expect(offerLine(offeredPlan({ plan })!)).toBe("$29.00 a month · cancel any time");
  });

  it("reads the offer without cookies or credentials, and shows it", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ plan })));
    vi.stubGlobal("fetch", fetch);
    const line = card();
    await mountOffer(line);
    expect(line.textContent).toBe("$29.00 a month · cancel any time");
    expect(fetch).toHaveBeenCalledWith(
      "https://app.opensteer.com/v1/cloud-computers/offer",
      expect.objectContaining({ credentials: "omit", mode: "cors", referrerPolicy: "no-referrer" }),
    );
  });

  it.each([
    ["checkout isn't ready", async () => new Response(JSON.stringify({ plan: null }))],
    ["the answer fails", async () => new Response("", { status: 503 })],
    ["the network fails", async () => Promise.reject(new TypeError("Failed to fetch"))],
    [
      "the answer is something else",
      async () => new Response(JSON.stringify({ plan: { amountMinor: "29" } })),
    ],
  ])("keeps saying it is paid monthly when %s", async (_, answer) => {
    vi.stubGlobal("fetch", vi.fn(answer));
    const line = card();
    await mountOffer(line);
    expect(line.textContent).toBe(today);
  });

  it("gives up on a late answer and keeps the card as it is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
      ),
    );
    const line = card();
    await mountOffer(line, 10);
    expect(line.textContent).toBe(today);
  });
});
