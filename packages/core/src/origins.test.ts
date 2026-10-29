import { describe, expect, it } from "vitest";
import {
  bareServiceOrigin,
  isBareOrigin,
  isLoopbackHostname,
  isSecureOrLoopbackOrigin,
} from "./origins.js";

describe("isLoopbackHostname", () => {
  it("accepts the whole 127.0.0.0/8 block, not just 127.0.0.1", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.0.0.53")).toBe(true);
    expect(isLoopbackHostname("127.255.255.254")).toBe(true);
    expect(isLoopbackHostname("128.0.0.1")).toBe(false);
    expect(isLoopbackHostname("126.255.255.255")).toBe(false);
  });

  it("normalizes case, brackets, and the fully-qualified trailing dot", () => {
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("localhost.")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("[::1].")).toBe(true);
    expect(isLoopbackHostname("::FFFF:127.0.0.1")).toBe(true);
  });

  it("reads every spelling of the same IPv6 address as one address", () => {
    expect(isLoopbackHostname("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackHostname("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(isLoopbackHostname("[0:0:0:0:0:0:0:1]")).toBe(true);
    expect(isLoopbackHostname("0:0::1")).toBe(true);
    expect(isLoopbackHostname("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("0:0:0:0:0:0:0:0")).toBe(false);
    expect(isLoopbackHostname("0:0:0:0:0:ffff:128.0.0.1")).toBe(false);
    expect(isLoopbackHostname("fe80::1")).toBe(false);
    expect(isLoopbackHostname("0:0:0:0:0:0:0:1:1")).toBe(false);
    expect(isLoopbackHostname("::1::1")).toBe(false);
    expect(isLoopbackHostname("::g")).toBe(false);
  });

  it("treats the reserved localhost subdomains as loopback", () => {
    expect(isLoopbackHostname("host.localhost")).toBe(true);
    expect(isLoopbackHostname(".localhost")).toBe(false);
    expect(isLoopbackHostname("notlocalhost")).toBe(false);
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
  });

  it("refuses the wildcard bind address and malformed octets", () => {
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("::")).toBe(false);
    expect(isLoopbackHostname("127.0.0.256")).toBe(false);
    expect(isLoopbackHostname("127.0.0")).toBe(false);
    expect(isLoopbackHostname("")).toBe(false);
  });
});

describe("bare service origins", () => {
  it("recognizes an origin that is already exactly itself", () => {
    expect(isBareOrigin("https://host.example")).toBe(true);
    expect(isBareOrigin("https://host.example/")).toBe(true);
    expect(isBareOrigin("https://host.example/path")).toBe(false);
    expect(isBareOrigin("https://user:secret@host.example")).toBe(false);
    expect(isBareOrigin("https://host.example/?a=1")).toBe(false);
    expect(isBareOrigin("https://host.example/#a")).toBe(false);
    expect(isBareOrigin("ftp://host.example")).toBe(false);
    expect(isBareOrigin("not a url")).toBe(false);
  });

  it("permits plaintext only toward this same computer", () => {
    expect(isSecureOrLoopbackOrigin("https://host.example")).toBe(true);
    expect(isSecureOrLoopbackOrigin("http://127.0.0.9:4141")).toBe(true);
    expect(isSecureOrLoopbackOrigin("http://[::1]:4141")).toBe(true);
    expect(isSecureOrLoopbackOrigin("http://host.example")).toBe(false);
    expect(isSecureOrLoopbackOrigin("http://0.0.0.0:4141")).toBe(false);
  });

  it("normalizes to the origin and names the offending setting", () => {
    expect(bareServiceOrigin("https://host.example/")).toBe("https://host.example");
    expect(bareServiceOrigin(new URL("http://LOCALHOST:4141/"))).toBe("http://localhost:4141");
    expect(() => bareServiceOrigin("https://host.example/path", "Account origin")).toThrow(
      /Account origin must be a bare origin\./u,
    );
    expect(() => bareServiceOrigin("http://host.example", "Account origin")).toThrow(
      /Account origin must use HTTPS or HTTP loopback\./u,
    );
    expect(() => bareServiceOrigin("nope", "Account origin")).toThrow(
      /Account origin must be an absolute URL\./u,
    );
  });
});
