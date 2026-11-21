// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { browserWakeLine, placeList } from "@opensteer/client/host";
import { MockHostClient, mockBrowserPoolReport } from "@opensteer/client/mock";
import { useBrowserSleep } from "@opensteer/client/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let client: MockHostClient | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.dispose();
  client = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function Probe({ hostClient, tabId }: { hostClient: MockHostClient; tabId: string }) {
  const sleep = useBrowserSleep(hostClient, tabId);
  const line = browserWakeLine(sleep.browser, sleep.elapsedMs, { picture: true });
  return <output>{`${sleep.browser.kind}|${line?.text ?? ""}`}</output>;
}

it("changes the line only at its steps, from when this device first saw the wait", async () => {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  const place = placeList(client.getSnapshot()).find((item) => item.kind === "page")!;
  const listed = client.getSnapshot().tabs.get(place.key as never);
  if (listed?.kind !== "page") throw new Error("Not a page tab");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const shown = () => container.textContent;
  act(() => root!.render(<Probe hostClient={client!} tabId={place.key} />));
  expect(shown()).toBe("not-pooled|");
  act(() =>
    client!.setBrowserPools([
      // The Home's clock says the wait began an hour ago: this device counts its own.
      mockBrowserPoolReport(
        "waking",
        listed.computer.computerId,
        place.key,
        new Date(Date.now() - 3_600_000).toISOString(),
      ),
    ]),
  );
  expect(shown()).toBe("waking|");
  act(() => {
    vi.advanceTimersByTime(399);
  });
  expect(shown()).toBe("waking|");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(shown()).toBe("waking|Last picture");
  act(() => {
    vi.advanceTimersByTime(1_600);
  });
  expect(shown()).toBe("waking|Last picture · Waking browser…");
  act(() => {
    vi.advanceTimersByTime(6_000);
  });
  expect(shown()).toBe("waking|Last picture · Taking longer than usual…");
  // Nothing is left to change, so nothing more is scheduled.
  expect(vi.getTimerCount()).toBe(0);
  act(() =>
    client!.setBrowserPools([
      mockBrowserPoolReport("awake", listed.computer.computerId, place.key),
    ]),
  );
  expect(shown()).toBe("awake|");
});
