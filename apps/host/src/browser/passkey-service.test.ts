import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PasskeyService, type PasskeyViewer } from "./passkey-service.js";
import type {
  BrowserPasskeyMessage,
  PasskeyCeremony,
  PasskeyOutcome,
} from "@opensteer/protocol/passkeys";
const refused: PasskeyOutcome = { kind: "refused", error: "NotAllowedError" };
const successful: PasskeyOutcome = {
  kind: "asserted",
  credentialId: "AQID",
  clientDataJSON: "BAUG",
  authenticatorData: "BwgJ",
  signature: "CgsM",
  userHandle: null,
  authenticatorAttachment: "platform",
};
function fixture() {
  const results: unknown[] = [];
  const viewers: PasskeyViewer[] = [];
  const messages = new Map<string, BrowserPasskeyMessage[]>();
  const service = new PasskeyService({
    ownOrigins: () => ["https://deployment.test", "https://account.test"],
    viewers: () => viewers,
    result: (value) => {
      results.push(value);
    },
  });
  const add = (mode: "native" | "notice" | undefined = "native") => {
    const token = randomUUID();
    const output: BrowserPasskeyMessage[] = [];
    messages.set(token, output);
    const viewer: PasskeyViewer = {
      token,
      userId: "person",
      fullControl: true,
      mode,
      surfaceId: "tab",
      live: true,
      authorized: async () => true,
      send: (message) => {
        output.push(message);
      },
    };
    viewers.push(viewer);
    return viewer;
  };
  const ceremony = (cause: PasskeyCeremony["cause"] = "unknown"): PasskeyCeremony => ({
    type: "passkey.ceremony",
    ceremonyId: randomUUID(),
    surfaceId: "tab",
    documentId: "document",
    op: "get",
    origin: "https://login.example.test",
    rpId: "example.test",
    options: {
      challenge: "AQID",
      allowCredentials: [],
      userVerification: "preferred",
      extensions: {},
    },
    clientDataJSON: "AQID",
    cause,
    deadline: Date.now() + 1000,
  });
  const requestId = (viewer: PasskeyViewer) => {
    const message = messages.get(viewer.token)!.at(-1)!;
    if (!("requestId" in message)) throw new Error("No request");
    return message.requestId;
  };
  return { service, viewers, messages, results, add, ceremony, requestId };
}
afterEach(() => {
  vi.useRealTimers();
});
it("routes person input only to its native viewer, and consumes the answer once", async () => {
  const f = fixture();
  const a = f.add();
  const b = f.add();
  f.service.ceremony(f.ceremony({ person: a.token }));
  expect(f.messages.get(a.token)![0]?.type).toBe("browser.passkey.request");
  expect(f.messages.get(b.token)).toEqual([]);
  const requestId = f.requestId(a);
  await f.service.viewer(b.token, { type: "passkey.respond", requestId, outcome: refused });
  expect(f.results).toEqual([]);
  await f.service.viewer(a.token, { type: "passkey.respond", requestId, outcome: refused });
  await f.service.viewer(a.token, { type: "passkey.respond", requestId, outcome: refused });
  expect(f.results).toHaveLength(1);
});
it("shows a notice and immediately refuses a person's notice viewer without rerouting", () => {
  const f = fixture();
  const a = f.add("notice");
  const b = f.add();
  f.service.ceremony(f.ceremony({ person: a.token }));
  expect(f.messages.get(a.token)![0]?.type).toBe("browser.passkey.notice");
  expect(f.messages.get(b.token)).toEqual([]);
  expect(f.results).toHaveLength(1);
});
it.each(["agent", "unknown"] as const)(
  "offers %s requests to opted-in viewers and only the first native claim wins",
  async (cause) => {
    const f = fixture();
    const a = f.add();
    const b = f.add();
    const notice = f.add("notice");
    const old = f.add(undefined);
    old.mode = undefined;
    f.service.ceremony(f.ceremony(cause));
    const requestId = f.requestId(a);
    expect(f.messages.get(notice.token)![0]?.type).toBe("browser.passkey.offer");
    expect(f.messages.get(old.token)).toEqual([]);
    await f.service.viewer(notice.token, { type: "passkey.claim", requestId });
    await Promise.all([
      f.service.viewer(a.token, { type: "passkey.claim", requestId }),
      f.service.viewer(b.token, { type: "passkey.claim", requestId }),
    ]);
    expect(f.messages.get(a.token)!.at(-1)?.type).toBe("browser.passkey.request");
    expect(f.messages.get(b.token)!.at(-1)?.type).toBe("browser.passkey.withdrawn");
    await f.service.viewer(b.token, { type: "passkey.respond", requestId, outcome: refused });
    expect(f.results).toEqual([]);
    f.service.close();
  },
);
it.each(["principal", "control", "surface", "live", "opt-in"])(
  "refuses without eligible %s authority",
  (check) => {
    const f = fixture();
    const a = f.add();
    if (check === "principal") a.userId = null;
    if (check === "control") a.fullControl = false;
    if (check === "surface") a.surfaceId = "other";
    if (check === "live") a.live = false;
    if (check === "opt-in") a.mode = undefined;
    f.service.ceremony(f.ceremony());
    expect(f.results).toHaveLength(1);
    expect(f.messages.get(a.token)).toEqual([]);
  },
);
it.each(["https://deployment.test", "https://account.test"])("refuses own site %s", (origin) => {
  const f = fixture();
  const a = f.add();
  f.service.ceremony({ ...f.ceremony(), origin });
  expect(f.results).toHaveLength(1);
  expect(f.messages.get(a.token)).toEqual([]);
});
it.each([
  "cancel",
  "disconnect",
  "presentation",
  "revocation",
  "deadline",
  "document",
  "generation",
])("settles %s and ignores a stale answer", async (ending) => {
  vi.useFakeTimers();
  const f = fixture();
  const a = f.add();
  const ceremony = f.ceremony({ person: a.token });
  f.service.ceremony(ceremony);
  const requestId = f.requestId(a);
  if (ending === "cancel") f.service.cancel(ceremony.ceremonyId);
  if (ending === "disconnect" || ending === "generation") f.service.close();
  if (ending === "presentation") {
    a.surfaceId = "other";
    f.service.refresh();
  }
  if (ending === "revocation") a.authorized = async () => false;
  if (ending === "deadline") vi.advanceTimersByTime(1001);
  if (ending === "document") f.service.ceremony({ ...f.ceremony(), documentId: "replacement" });
  await f.service.viewer(a.token, { type: "passkey.respond", requestId, outcome: successful });
  expect(f.results).toContainEqual({
    type: "passkey.result",
    ceremonyId: ceremony.ceremonyId,
    outcome: refused,
  });
  const count = f.results.length;
  await f.service.viewer(a.token, { type: "passkey.respond", requestId, outcome: successful });
  expect(f.results).toHaveLength(count);
  f.service.close();
});
it("does not accept a request from a previous connection or replay a ceremony", async () => {
  const f = fixture();
  const a = f.add();
  const request = f.ceremony();
  f.service.ceremony(request);
  const requestId = f.requestId(a);
  f.service.cancel(request.ceremonyId);
  f.service.ceremony(request);
  await f.service.viewer(a.token, { type: "passkey.claim", requestId });
  expect(f.messages.get(a.token)!.filter((m) => m.type === "browser.passkey.request")).toEqual([]);
  expect(f.results).toHaveLength(1);
});
it("keeps authenticator bytes unchanged and refuses a success that crosses the deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const a = f.add();
  const outcome = {
    kind: "asserted" as const,
    credentialId: "AQID",
    clientDataJSON: "BAUG",
    authenticatorData: "BwgJ",
    signature: "CgsM",
    userHandle: null,
    authenticatorAttachment: "platform" as const,
  };
  f.service.ceremony(f.ceremony({ person: a.token }));
  await f.service.viewer(a.token, { type: "passkey.respond", requestId: f.requestId(a), outcome });
  expect(f.results[0]).toMatchObject({ outcome });
  f.service.ceremony(f.ceremony({ person: a.token }));
  const requestId = f.requestId(a);
  let authorize: (allowed: boolean) => void = () => {};
  a.authorized = () =>
    new Promise((resolve) => {
      authorize = resolve;
    });
  const responding = f.service.viewer(a.token, { type: "passkey.respond", requestId, outcome });
  vi.advanceTimersByTime(1001);
  authorize(true);
  await responding;
  expect(f.results[1]).toMatchObject({ outcome: { kind: "refused", error: "NotAllowedError" } });
  expect(f.results).toHaveLength(2);
  f.service.close();
});

it.each(["deadline", "cancel", "close", "viewer-cancel"] as const)(
  "releases the sequential viewer queue on %s while authorization stalls",
  async (ending) => {
    vi.useFakeTimers();
    const f = fixture();
    const viewer = f.add();
    const ceremony = f.ceremony({ person: viewer.token });
    f.service.ceremony(ceremony);
    const requestId = f.requestId(viewer);
    viewer.authorized = () => new Promise(() => {});
    const next = vi.fn();
    let settled = false;
    const queued = f.service
      .viewer(viewer.token, {
        type: "passkey.respond",
        requestId,
        outcome: {
          kind: "asserted",
          credentialId: "AQID",
          clientDataJSON: "BAUG",
          authenticatorData: "BwgJ",
          signature: "CgsM",
          userHandle: null,
          authenticatorAttachment: "platform",
        },
      })
      .then(() => {
        settled = true;
        next("navigation.reload");
      });
    try {
      if (ending === "cancel") f.service.cancel(ceremony.ceremonyId);
      if (ending === "close") f.service.close();
      if (ending === "viewer-cancel")
        await f.service.viewer(viewer.token, { type: "passkey.cancel", requestId });
      await vi.advanceTimersByTimeAsync(ending === "deadline" ? 1001 : 0);
      expect(settled).toBe(true);
      expect(next).toHaveBeenCalledExactlyOnceWith("navigation.reload");
      await queued;
      expect(f.results).toEqual([
        {
          type: "passkey.result",
          ceremonyId: ceremony.ceremonyId,
          outcome: { kind: "refused", error: "NotAllowedError" },
        },
      ]);
    } finally {
      f.service.close();
    }
  },
);

it("releases a stalled claim at the original deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const viewer = f.add();
  const ceremony = f.ceremony();
  f.service.ceremony(ceremony);
  viewer.authorized = () => new Promise(() => {});
  let settled = false;
  const claim = f.service
    .viewer(viewer.token, { type: "passkey.claim", requestId: f.requestId(viewer) })
    .then(() => {
      settled = true;
    });
  try {
    await vi.advanceTimersByTimeAsync(1001);
    expect(settled).toBe(true);
    await claim;
    expect(f.results).toEqual([
      { type: "passkey.result", ceremonyId: ceremony.ceremonyId, outcome: refused },
    ]);
  } finally {
    f.service.close();
  }
});

it("withdraws a presenting device's cancelled offer without reviving it on the retained socket", async () => {
  const f = fixture();
  const first = f.add();
  const second = f.add();
  f.service.ceremony(f.ceremony());
  const requestId = f.requestId(first);
  try {
    await f.service.viewer(first.token, { type: "passkey.cancel", requestId });
    expect(f.messages.get(first.token)!.at(-1)).toEqual({
      type: "browser.passkey.withdrawn",
      requestId,
    });
    await f.service.viewer(first.token, { type: "passkey.claim", requestId });
    expect(
      f.messages.get(first.token)!.filter((message) => message.type === "browser.passkey.request"),
    ).toEqual([]);
    await f.service.viewer(second.token, { type: "passkey.claim", requestId });
    expect(f.messages.get(second.token)!.at(-1)?.type).toBe("browser.passkey.request");
  } finally {
    f.service.close();
  }
});

it("refuses after the last offered presentation cancels, even if it later returns success", async () => {
  const f = fixture();
  const viewer = f.add();
  const ceremony = f.ceremony();
  f.service.ceremony(ceremony);
  const requestId = f.requestId(viewer);
  try {
    await f.service.viewer(viewer.token, { type: "passkey.cancel", requestId });
    expect(f.results).toEqual([
      { type: "passkey.result", ceremonyId: ceremony.ceremonyId, outcome: refused },
    ]);
    await f.service.viewer(viewer.token, {
      type: "passkey.respond",
      requestId,
      outcome: successful,
    });
    expect(f.results).toEqual([
      { type: "passkey.result", ceremonyId: ceremony.ceremonyId, outcome: refused },
    ]);
  } finally {
    f.service.close();
  }
});
