import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { webContents } from "electron";
import { createId } from "@opensteer/core";
import {
  ComputerUseSessionIdSchema,
  type CardField,
  type PasswordSignInAuthorityEvent,
} from "@opensteer/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { PasswordsLoginAuthority } from "./login-authority.js";
import type { PasswordsBrokerSession, PasswordsBrokerCardSession } from "./broker-session.js";
vi.mock("electron", () => ({ webContents: { fromDevToolsTargetId: vi.fn() } }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers();
});
async function fixture(select = false) {
  const events: PasswordSignInAuthorityEvent[] = [];
  const card = {
    id: randomUUID(),
    revision: 1,
    brand: "Visa",
    lastFour: "4242",
    label: null,
    expiryMonth: 1,
    expiryYear: 2030,
  };
  const release = { released: true as const, value: "synthetic-card-canary" };
  const broker: PasswordsBrokerSession & PasswordsBrokerCardSession = {
    protocolVersion: 7,
    probe: vi.fn(),
    request: vi.fn(),
    approve: vi.fn(),
    release: vi.fn(),
    cancel: vi.fn(async () => {}),
    commit: vi.fn(async () => ({ committed: true })),
    cardProbe: vi.fn(async () => ({ cards: "has-card" as const })),
    cardRequest: vi.fn(async () => ({
      decision: { decision: "approve" as const, cards: [card] },
      lifetime: new AbortController().signal,
    })),
    cardApprove: vi.fn(async () => ({ decision: "authorized" as const, card })),
    cardRelease: vi.fn(async () => release),
  };
  const authority = new PasswordsLoginAuthority({
    broker,
    ownOrigins: () => ["https://opensteer.test"],
  });
  cleanups.push(() => authority.close());
  const id = randomUUID(),
    cardRef = `crd_${"a".repeat(32)}`;
  const emit = (event: PasswordSignInAuthorityEvent) => events.push(event);
  await authority.control(
    {
      type: "login.authorize",
      credential: "card",
      operationId: id,
      cardRef,
      site: "https://merchant.test",
      workspaceId: createId("workspace"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requester: {
        deploymentId: "personal",
        deploymentName: "Personal",
        workspaceName: "Main",
        threadTitle: "Checkout",
        reason: "Pay",
      },
    },
    emit,
  );
  await vi.waitFor(() => expect(events.some((e) => e.type === "login.needs")).toBe(true));
  await authority.control(
    {
      type: "login.approve",
      credential: "card",
      operationId: id,
      cardId: card.id,
      revision: 1,
      permissionVersion: 7,
    },
    emit,
  );
  const writes: string[] = [];
  class Input {
    isConnected = true;
    disabled = false;
    readOnly = false;
    type = "tel";
    matches() {
      return false;
    }
    dispatchEvent() {
      return true;
    }
    set value(value: string) {
      writes.push(value);
    }
  }
  class Select extends Input {
    options: { value: string; label: string; disabled: boolean }[] = [];
    override set value(value: string) {
      writes.push(value);
    }
  }
  const element = select ? new Select() : new Input();
  const document = { activeElement: element };
  const context = {
    window: {},
    document,
    location: { origin: "https://payments.test" },
    HTMLInputElement: Input,
    HTMLSelectElement: Select,
    HTMLOptGroupElement: class {},
    Event: class {
      constructor(_type: string, _options: unknown) {}
    },
  };
  const top = {
    origin: "https://merchant.test",
    url: "https://merchant.test/checkout",
    parent: null,
  };
  const frame = {
    origin: "https://payments.test",
    url: "https://payments.test/field",
    detached: false,
    parent: top,
    executeJavaScript: vi.fn(async (script: string) => runInNewContext(script, context)),
  };
  const wc = Object.assign(new EventEmitter(), {
    mainFrame: top,
    focusedFrame: frame,
    isDestroyed: () => false,
  });
  vi.mocked(webContents.fromDevToolsTargetId).mockReturnValue(
    wc as unknown as Electron.WebContents,
  );
  const fill = (field: CardField = "number") =>
    authority.fillCardReference({
      cardRef,
      field,
      targetId: "target",
      lease: new AbortController().signal,
    });
  const commit = () => authority.control({ type: "login.commit", operationId: id }, emit);
  return {
    authority,
    broker,
    release,
    events,
    writes,
    element,
    top,
    frame,
    wc,
    fill,
    commit,
    id,
    cardRef,
    emit,
  };
}
it("requires commit and writes to the cross-origin focused input without returning a value", async () => {
  const f = await fixture();
  expect(await f.fill()).toBe("expired");
  expect(f.broker.cardRelease).not.toHaveBeenCalled();
  await f.commit();
  expect(await f.fill()).toBe("filled");
  expect(f.writes).toEqual(["synthetic-card-canary"]);
  expect(f.release.value).toBe("");
  expect(JSON.stringify(f.events)).not.toContain("synthetic-card-canary");
  expect(
    await f.authority.control(
      {
        type: "login.seal",
        operationId: f.id,
        receiver: {
          version: 1,
          connectionId: "test",
          connectionGeneration: 1,
          publicKey: `B${"a".repeat(86)}`,
        },
        binding: {
          version: 1,
          connectionId: "test",
          connectionGeneration: 1,
          runId: createId("run"),
          sessionId: ComputerUseSessionIdSchema.parse(`cus_${randomUUID()}`),
          actId: "test",
          actionIndex: 0,
          field: "password",
          expiresAt: Date.now() + 1000,
        },
      },
      f.emit,
    ),
  ).toMatchObject({ status: "expired" });
});
it.each(["about:blank", "about:srcdoc", "http://payments.test/field"])(
  "refuses inherited or insecure frame URL %s",
  async (url) => {
    const f = await fixture();
    await f.commit();
    f.frame.url = url;
    expect(await f.fill()).toBe("wrong-site");
    expect(f.broker.cardRelease).not.toHaveBeenCalled();
  },
);
it("refuses another top site before release", async () => {
  const f = await fixture();
  await f.commit();
  f.top.origin = "https://other.test";
  f.top.url = f.top.origin;
  expect(await f.fill()).toBe("wrong-site");
  expect(f.broker.cardRelease).not.toHaveBeenCalled();
});
it.each(["navigation", "focus", "detach", "deadline"])(
  "discards an in-flight release after %s",
  async (change) => {
    const f = await fixture();
    await f.commit();
    vi.mocked(f.broker.cardRelease).mockImplementationOnce(async () => {
      if (change === "navigation") f.wc.emit("did-start-navigation", {}, f.top.url, false);
      if (change === "focus") f.wc.focusedFrame = { ...f.frame };
      if (change === "detach") f.frame.detached = true;
      if (change === "deadline") {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 60_000);
      }
      return f.release;
    });
    expect(await f.fill()).toBe(change === "deadline" ? "expired" : "stale");
    expect(f.writes).toEqual([]);
    expect(f.release.value).toBe("");
  },
);
it.each(["01", "January", "Jan", "01 - Jan"])("matches month select label %s", async (label) => {
  const f = await fixture(true);
  await f.commit();
  f.release.value = "01";
  if ("options" in f.element)
    f.element.options = [{ value: "provider-option", label, disabled: false }];
  expect(await f.fill("expiry-month")).toBe("filled");
  expect(f.writes).toEqual(["provider-option"]);
});
it("matches named months by label when their values are zero-based", async () => {
  const f = await fixture(true);
  await f.commit();
  f.release.value = "01";
  const months = ["January", "February", "March", "April", "May", "June"];
  if ("options" in f.element)
    f.element.options = [
      { value: "", label: "Month", disabled: false },
      ...months.map((label, index) => ({ value: String(index), label, disabled: false })),
    ];
  expect(await f.fill("expiry-month")).toBe("filled");
  expect(f.writes).toEqual(["0"]);
});
it("refuses ambiguous and unsupported selects", async () => {
  const f = await fixture(true);
  await f.commit();
  f.release.value = "2030";
  if ("options" in f.element)
    f.element.options = [
      { value: "30", label: "2030", disabled: false },
      { value: "2030", label: "2030", disabled: false },
    ];
  expect(await f.fill("expiry-year")).toBe("no-field");
  expect(await f.fill("number")).toBe("no-field");
  expect(f.writes).toEqual([]);
});
it("ends card references on cancellation", async () => {
  const f = await fixture();
  await f.commit();
  await f.authority.end(f.id);
  expect(await f.fill()).toBe("expired");
  expect(f.broker.cancel).toHaveBeenCalledWith(f.id);
});
