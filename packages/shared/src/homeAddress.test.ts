import { describe, expect, it } from "vitest";
import { ThisHomeAddressSet, isThisHomeAddress, noHomeAddresses } from "./homeAddress.js";

const home = {
  origins: ["https://home.example.com", "https://route.opensteer.test:8443/ignored-path"],
  loopbackPorts: [4310],
};

describe("isThisHomeAddress", () => {
  const yes: string[] = [
    "https://home.example.com/",
    "https://HOME.example.com/tasks?x=1#frag",
    "wss://home.example.com/v1/realtime",
    "https://route.opensteer.test:8443/",
    "http://127.0.0.1:4310/",
    "http://localhost:4310/settings",
    "http://LOCALHOST:4310/",
    "http://app.localhost:4310/",
    "http://127.9.8.7:4310/",
    "http://[::1]:4310/",
    "http://[0:0:0:0:0:0:0:1]:4310/",
    "http://[::ffff:127.0.0.1]:4310/",
    "http://0x7f000001:4310/",
    "http://0.0.0.0:4310/",
    "http://localhost.:4310/",
    "view-source:http://127.0.0.1:4310/",
    "blob:https://home.example.com/0b7d1d38-1111-4222-8333-944455556666",
    "filesystem:http://localhost:4310/temporary/x",
    "\thttps://home.example.com/",
    "https://home%2eexample.com/",
  ];
  for (const value of yes)
    it(`is the Home: ${JSON.stringify(value)}`, () => {
      expect(isThisHomeAddress(value, home)).toBe(true);
    });

  const no: unknown[] = [
    "http://localhost:5173/",
    "http://127.0.0.1:3000/",
    "http://[::1]:8080/",
    "https://home.example.com:444/",
    "http://home.example.com/",
    "https://route.opensteer.test/",
    "https://evil.example/https://home.example.com/",
    "https://evil.example/?u=http://localhost:4310",
    "http://192.168.1.10:4310/",
    "about:blank",
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html",
    "data:text/html,<a href=http://localhost:4310>",
    "not a url",
    42,
    undefined,
  ];
  for (const value of no)
    it(`is not the Home: ${JSON.stringify(value)}`, () => {
      expect(isThisHomeAddress(value, home)).toBe(false);
    });

  it("knows no address before the Home has told it", () => {
    expect(new ThisHomeAddressSet(noHomeAddresses).empty).toBe(true);
    expect(isThisHomeAddress("http://localhost:4310/", noHomeAddresses)).toBe(false);
  });

  it("treats a loopback Home on a default port as every loopback host on it", () => {
    const local = new ThisHomeAddressSet({ origins: [], loopbackPorts: [80] });
    expect(local.includes("http://localhost/")).toBe(true);
    expect(local.includesReported("http://127.0.0.1/")).toBe(true);
    expect(local.includes("http://localhost:8080/")).toBe(false);
  });

  it("answers a browser-reported address the same as a parsed one, scanning it first", () => {
    const set = new ThisHomeAddressSet(home);
    const reported = [
      "https://home.example.com/",
      "http://127.0.0.1:4310/",
      "http://[::1]:4310/",
      "http://[::ffff:7f00:1]:4310/",
      "view-source:http://localhost:4310/",
      "http://localhost:5173/",
      "https://web.test/",
    ];
    for (const value of reported)
      expect(set.includesReported(value), value).toBe(set.includes(value));
  });

  it("keeps the data form for the wire", () => {
    expect(new ThisHomeAddressSet(home).toJSON()).toEqual({
      origins: ["https://home.example.com", "https://route.opensteer.test:8443"],
      loopbackPorts: [4310],
    });
  });
});
