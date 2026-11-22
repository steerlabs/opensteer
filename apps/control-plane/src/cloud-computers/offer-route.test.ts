import { cloudComputerOfferPath } from "@opensteer/control-plane-protocol";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerCloudComputerRoutes } from "./routes.js";
import type { CloudComputerStore } from "./store.js";

const plan = { name: "Cloud Computer", currency: "usd", amountMinor: 2900, interval: "month" };
const website = new URL("https://opensteer.com");
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(offer: typeof plan | null) {
  const app = Fastify();
  registerCloudComputerRoutes(app, {
    store: { offer } as unknown as CloudComputerStore,
    authenticator: {
      authenticate: async () => {
        throw new Error("The public offer never authenticates anyone");
      },
    },
    verifyProvisioner: async () => undefined,
    stripeWebhookSecret: "whsec_test",
    websiteOrigin: website,
  });
  await app.ready();
  close = () => app.close();
  return app;
}

describe("the public Cloud Computer offer", () => {
  it("answers the account service's own plan, the same for everyone, cacheable", async () => {
    const app = await serve(plan);
    const response = await app.inject({
      method: "GET",
      url: cloudComputerOfferPath,
      // A cookie changes nothing: nothing here reads who is asking.
      headers: { origin: website.origin, cookie: "session=whoever" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plan });
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    expect(response.headers["vary"]).toBe("Origin");
    expect(response.headers["access-control-allow-origin"]).toBe(website.origin);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("lets no other website's page read it", async () => {
    const app = await serve(plan);
    const response = await app.inject({
      method: "GET",
      url: cloudComputerOfferPath,
      headers: { origin: "https://elsewhere.example" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("says no plan while checkout isn't ready", async () => {
    const app = await serve(null);
    const response = await app.inject({ method: "GET", url: cloudComputerOfferPath });
    expect(response.json()).toEqual({ plan: null });
  });
});
