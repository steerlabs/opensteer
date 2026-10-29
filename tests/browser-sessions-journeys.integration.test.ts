import {
  run,
  addCleanup,
  deployment,
  startBrowser,
  killChromium,
} from "./browser-deployment.test-support.js";
import { randomBytes } from "node:crypto";
import { it } from "vitest";
import { agentJourney, startBrowserService } from "./browser-sessions.test-support.js";

/**
 * The browser as an agent sees it, through a whole deployment: a real Host and
 * PostgreSQL, a real Runner with its CDP relay, the shipped Browser Harness,
 * and real Chromium relayed over the Runner's browser bridge. A scripted
 * engine plays the agent, using only what the tools and the skill give it.
 *
 * It opens two sessions and drives them by ID side by side, uploads the photo
 * attached to the chat through a file input and a file chooser, and reads the
 * message every mistake produces. On a granted profile it learns access is
 * already there, signs a site in, and the profile keeps that sign-in across a
 * browser crash because it was saved while in use. The run writes a JSON
 * report to the system temporary directory.
 */
run("Browser Sessions through a whole deployment", () => {
  it("works on a browser the agent's own computer relays, as on desktop", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await agentJourney(stack, "relayed", () => killChromium(process.pid));
  }, 240_000);

  it("works on a browser service of its own, as self-hosted and in the cloud", async () => {
    const enrollmentToken = randomBytes(36).toString("base64url");
    const stack = await deployment(undefined, enrollmentToken);
    const service = await startBrowserService(stack, enrollmentToken);
    await agentJourney(stack, "service", () => killChromium(service.pid));
  }, 240_000);
});
