import { describe, expect, it } from "vitest";
import {
  DesktopAppOriginPolicy,
  HostOriginPolicy,
  ServiceOriginPolicy,
} from "./navigation-policy.js";

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
    const policy = new ServiceOriginPolicy(new URL("https://accounts.beta.opensteer.com"));

    expect(policy.allowsNetworkRequest("https://accounts.beta.opensteer.com/oauth/token")).toBe(
      true,
    );
    expect(policy.allowsNetworkRequest("https://accounts.beta.opensteer.com.evil.test/")).toBe(
      false,
    );
    expect(policy.allowsNetworkRequest("https://beta.opensteer.com/")).toBe(false);
    expect(policy.allowsNetworkRequest("wss://accounts.beta.opensteer.com/socket")).toBe(false);
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
