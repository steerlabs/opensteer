import { BrowserEditingStore, type BrowserCommand } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { createPageAutofill } from "./page-autofill.js";

const surfaceId = BrowserSurfaceIdSchema.parse("page-1");
const consumerToken = "00000000-0000-4000-8000-000000000001";
const offerId = "00000000-0000-4000-8000-0000000000a1";
const confirmed = "00000000-0000-4000-8000-0000000000b1";
const unconfirmed = "00000000-0000-4000-8000-0000000000b2";

function setup(authenticate: () => Promise<boolean>) {
  const sent: BrowserCommand[] = [];
  const store = new BrowserEditingStore((_session, _surface, command) => sent.push(command));
  const editing = store.target("session-1", surfaceId);
  const events = {
    confirming: [] as (string | null)[],
    chosen: vi.fn(),
    filled: vi.fn(),
    unfilled: vi.fn(),
  };
  const autofill = createPageAutofill({
    editing,
    authenticate,
    onConfirming: (loginId) => events.confirming.push(loginId),
    onChosen: events.chosen,
    onFilled: events.filled,
    onUnfilled: events.unfilled,
  });
  const offer = (id = offerId) =>
    store.receive("session-1", {
      type: "browser.autofill.offer",
      surfaceId,
      consumerToken,
      offerId: id,
      role: "password",
      geometryRevision: 1,
      anchor: { x: 0.1, y: 0.4, width: 0.8, height: 0.05 },
      accounts: [
        { id: confirmed, revision: 3, username: "alex@acme.co", label: null, ready: true },
        { id: unconfirmed, revision: 1, username: "ops@acme.co", label: null, ready: false },
      ],
    });
  const fills = () =>
    sent.filter(
      (command): command is Extract<BrowserCommand, { type: "autofill.fill" }> =>
        command.type === "autofill.fill",
    );
  return { autofill, events, fills, offer, store };
}

describe("page autofill", () => {
  it("fills a login the Mac already confirmed without asking again, and reports the result", () => {
    const authenticate = vi.fn(async () => true);
    const { autofill, events, fills, offer, store } = setup(authenticate);
    offer();
    void autofill.choose(confirmed);
    expect(authenticate).not.toHaveBeenCalled();
    expect(fills()).toEqual([
      { type: "autofill.fill", surfaceId, offerId, loginId: confirmed, revision: 3 },
    ]);
    store.receive("session-1", {
      type: "browser.autofill.result",
      surfaceId,
      consumerToken,
      offerId,
      status: "filled",
    });
    store.receive("session-1", {
      type: "browser.autofill.withdrawn",
      surfaceId,
      consumerToken,
      offerId,
    });
    expect(events.filled).toHaveBeenCalledTimes(1);
    expect(events.unfilled).not.toHaveBeenCalled();
  });

  it("checks the device owner first, and a cancelled check fills nothing", async () => {
    const { autofill, events, fills, offer } = setup(async () => false);
    offer();
    await autofill.choose(unconfirmed);
    expect(events.confirming).toEqual([unconfirmed, null]);
    expect(fills()).toEqual([]);
    expect(events.unfilled).not.toHaveBeenCalled();
  });

  it("keeps the choice across the device check, and drops it if the offer went away", async () => {
    let answer: (value: boolean) => void = () => undefined;
    const { autofill, events, fills, offer, store } = setup(
      () => new Promise((resolve) => (answer = resolve)),
    );
    offer();
    const chosen = autofill.choose(unconfirmed);
    // A second tap while the prompt is up is the same choice, not another.
    void autofill.choose(confirmed);
    answer(true);
    await chosen;
    expect(fills().map(({ loginId }) => loginId)).toEqual([unconfirmed]);
    expect(events.chosen).toHaveBeenCalledTimes(1);

    offer("00000000-0000-4000-8000-0000000000a2");
    const withdrawn = autofill.choose(unconfirmed);
    store.receive("session-1", {
      type: "browser.autofill.withdrawn",
      surfaceId,
      consumerToken,
      offerId: "00000000-0000-4000-8000-0000000000a2",
    });
    answer(true);
    await withdrawn;
    expect(fills()).toHaveLength(1);
    expect(events.unfilled).not.toHaveBeenCalled();
  });

  it("says why a fill did not happen, except when the person cancelled", async () => {
    const { autofill, events, offer, store } = setup(async () => {
      throw new Error("Confirm with Face ID.");
    });
    offer();
    await autofill.choose(unconfirmed);
    expect(events.unfilled).toHaveBeenLastCalledWith("Confirm with Face ID.");

    for (const status of ["cancelled", "changed"] as const) {
      void autofill.choose(confirmed);
      store.receive("session-1", {
        type: "browser.autofill.result",
        surfaceId,
        consumerToken,
        offerId,
        status,
      });
    }
    expect(events.unfilled).toHaveBeenCalledTimes(2);
    expect(events.unfilled).toHaveBeenLastCalledWith(
      "This login changed on your Mac. Tap the field to see it again.",
    );
  });
});
