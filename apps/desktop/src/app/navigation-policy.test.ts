import { describe, expect, it } from "vitest";
import {
  attachedHostOrigin,
  clearOnReattachment,
  DesktopAppOriginPolicy,
  HostOriginPolicy,
  ServiceOriginPolicy,
} from "./navigation-policy.js";

it("lets only the current attachment answer an attachment lookup", async () => {
  type Selected = { readonly resolved: { readonly key: string; readonly origin: string } };
  let key = "first";
  let finish!: (selected: Selected) => void;
  const transport = {
    current: () => new Promise<Selected>((resolve) => (finish = resolve)),
    currentKey: () => key,
  };
  const late = attachedHostOrigin(transport);
  key = "second";
  finish({ resolved: { key: "first", origin: "https://first.test" } });
  await expect(late).resolves.toBeNull();
  const current = attachedHostOrigin(transport);
  finish({ resolved: { key: "second", origin: "https://second.test" } });
  await expect(current).resolves.toBe("https://second.test");
});

it("ends the old Deployment's access on re-attachment and on nothing else", () => {
  let key: string | null = "first";
  let notify!: () => void;
  const cleared: (string | null)[] = [];
  clearOnReattachment(
    { setAttachedHost: (host) => cleared.push(host) },
    {
      currentKey: () => key,
      subscribe: (listener) => {
        notify = listener;
        return () => undefined;
      },
    },
  );
  notify();
  expect(cleared).toEqual([]);
  key = "second";
  notify();
  expect(cleared).toEqual([null]);
});

describe("DesktopAppOriginPolicy", () => {
  it("allows only bundled app documents and inert local resources", () => {
    const policy = new DesktopAppOriginPolicy();
    expect(policy.allowsNavigation("app://opensteer/workspaces/one#thread")).toBe(true);
    expect(policy.allowsNavigation("app://attacker/workspaces/one")).toBe(false);
    expect(policy.allowsNavigation("https://opensteer.example.test")).toBe(false);
    expect(policy.allowsNavigation("file:///etc/passwd")).toBe(false);
    expect(policy.allowsNetworkRequest("app://opensteer/assets/app.js")).toBe(true);
    expect(policy.allowsNetworkRequest("blob:app://opensteer/asset-id")).toBe(true);
    expect(policy.allowsNetworkRequest("data:image/png;base64,AA==")).toBe(true);
    expect(policy.allowsNetworkRequest("https://opensteer.example.test/v1/bootstrap")).toBe(false);
    expect(policy.allowsNetworkRequest("wss://opensteer.example.test/v1/realtime")).toBe(false);
  });
});

describe("ServiceOriginPolicy", () => {
  it("allows only HTTP requests to its exact service origin", () => {
    const policy = new ServiceOriginPolicy(new URL("https://accounts.opensteer.com"));

    expect(policy.allowsNetworkRequest("https://accounts.opensteer.com/oauth/token")).toBe(true);
    expect(policy.allowsNetworkRequest("https://accounts.opensteer.com.evil.test/")).toBe(false);
    expect(policy.allowsNetworkRequest("https://beta.opensteer.com/")).toBe(false);
    expect(policy.allowsNetworkRequest("wss://accounts.opensteer.com/socket")).toBe(false);
    expect(policy.allowsNetworkRequest("data:text/plain,secret")).toBe(false);
  });
});

describe("HostOriginPolicy", () => {
  it("allows only exact-origin documents and network transports", () => {
    const policy = new HostOriginPolicy(new URL("https://opensteer.example.test"));
    expect(policy.allowsNavigation("https://opensteer.example.test/workspaces/one")).toBe(true);
    expect(policy.allowsNavigation("https://opensteer.example.test.attacker.test/")).toBe(false);
    expect(policy.allowsNavigation("javascript:alert(1)")).toBe(false);
    expect(policy.allowsNetworkRequest("wss://opensteer.example.test/v1/realtime")).toBe(true);
    expect(policy.allowsNetworkRequest("https://cdn.example.test/script.js")).toBe(false);
    expect(policy.allowsNetworkRequest("file:///tmp/credential")).toBe(false);
    expect(
      policy.allowsNetworkRequest("blob:https://opensteer.example.test/asset-identifier"),
    ).toBe(true);
    expect(policy.allowsNetworkRequest("data:image/png;base64,AA==")).toBe(true);
  });

  it("does not treat secure and plaintext WebSockets as the same origin", () => {
    const policy = new HostOriginPolicy(new URL("http://127.0.0.1:4310"));
    expect(policy.allowsNetworkRequest("ws://127.0.0.1:4310/v1/realtime")).toBe(true);
    expect(policy.allowsNetworkRequest("wss://127.0.0.1:4310/v1/realtime")).toBe(false);
  });
});

it("limits real app frames and worker traffic to the current attachment", () => {
  const policy = new DesktopAppOriginPolicy();
  const key = "a".repeat(26);
  const dep = "11111111111141118111111111111111";
  const origin = `https://${key}-${dep}.example.test`;
  policy.setAttachedHost("https://connect-11111111-1111-4111-8111-111111111111.example.test");
  const frame = { url: "app://opensteer", resourceType: "subFrame" };
  expect(policy.allowsNetworkRequest(origin + "/?opensteer-ticket=test", frame)).toBe(true);
  expect(policy.allowsNetworkRequest(origin.replace(dep, "2".repeat(32)), frame)).toBe(false);
  expect(policy.allowsNetworkRequest(origin + ".evil.test", frame)).toBe(false);
  expect(
    policy.allowsNetworkRequest(origin.replace(dep, "2".repeat(32)), {
      url: origin,
      resourceType: "xhr",
      initiatorOrigin: origin,
    }),
  ).toBe(false);
  expect(policy.allowsNetworkRequest(origin, { ...frame, resourceType: "xhr" })).toBe(false);
  for (const url of [
    "https://api.example.test/data",
    "http://api.example.test/data",
    "wss://api.example.test/ws",
    "ws://api.example.test/ws",
  ]) {
    expect(
      policy.allowsNetworkRequest(url, { url: "", resourceType: "xhr", initiatorOrigin: origin }),
    ).toBe(true);
    expect(
      policy.allowsNetworkRequest(url, {
        url: "",
        resourceType: "xhr",
        initiatorOrigin: "app://opensteer",
      }),
    ).toBe(false);
  }
  expect(policy.allowsNavigation(origin + "/next", origin)).toBe(true);
  expect(policy.allowsNavigation("https://elsewhere.test", origin)).toBe(false);
  policy.setAttachedHost("http://127.0.0.1:4310");
  expect(policy.allowsNetworkRequest(origin, frame)).toBe(false);
  expect(policy.allowsNetworkRequest(`http://${key}.localhost:4310/`, frame)).toBe(true);
  expect(policy.allowsNetworkRequest(`http://${key}.localhost:4311/`, frame)).toBe(false);
  expect(policy.allowsNetworkRequest(`http://${key}.localhost.evil.test:4310/`, frame)).toBe(false);
  policy.setAttachedHost(null);
  expect(policy.allowsNetworkRequest(`http://${key}.localhost:4310/`, frame)).toBe(false);
});
