import { describe, expect, it, vi } from "vitest";
import { HomeAddressBook, thisHomeAddresses } from "./home-addresses.js";
import { signInSiteRefusal } from "./sign-in-admission.js";

describe("HomeAddressBook", () => {
  it("is the canonical origin, the current route and loopback on this Home's own ports", async () => {
    let route: string | null = null;
    const readRoute = vi.fn(async () => route);
    const book = new HomeAddressBook({
      canonicalOrigin: new URL("http://127.0.0.1:4310"),
      listenPort: 4310,
      readRoute,
    });
    expect(book.current().toJSON()).toEqual({
      origins: ["http://127.0.0.1:4310"],
      loopbackPorts: [4310],
    });
    route = "https://route.opensteer.test";
    // Reading the set reads nothing: the route is the one the last refresh read.
    expect(book.current().includes("https://route.opensteer.test/")).toBe(false);
    expect(readRoute).not.toHaveBeenCalled();
    await book.refresh();
    expect(book.current().includes("https://route.opensteer.test/")).toBe(true);
    expect(book.current().includes("http://localhost:4310/")).toBe(true);
    expect(book.current().includes("http://localhost:5173/")).toBe(false);
    route = null;
    await book.refresh();
    expect(book.current().includes("https://route.opensteer.test/")).toBe(false);
  });

  it("counts the listen port and a loopback canonical origin's own port", () => {
    const book = new HomeAddressBook({
      canonicalOrigin: new URL("http://localhost:8080"),
      listenPort: 4310,
      readRoute: async () => null,
    });
    expect([...book.current().loopbackPorts].sort()).toEqual([4310, 8080]);
    const hosted = new HomeAddressBook({
      canonicalOrigin: new URL("https://home.example.com"),
      listenPort: 4310,
      readRoute: async () => null,
    });
    expect(hosted.current().toJSON()).toEqual({
      origins: ["https://home.example.com"],
      loopbackPorts: [4310],
    });
  });

  it("gives sign-in admission the same origins it refuses, and every loopback site besides", async () => {
    const refuses = signInSiteRefusal({
      canonicalOrigin: "https://home.example.com",
      currentRoute: async () => null,
      // Sites are registrable domains: the Home's site is example.com.
    });
    expect(await refuses("https://example.com")).toBe(true);
    expect(await refuses("http://localhost")).toBe(true);
    expect(await refuses("https://web.test")).toBe(false);
    expect(
      thisHomeAddresses({
        canonicalOrigin: "https://home.example.com",
        routeOrigin: "https://route.test",
        loopbackPorts: [],
      }).origins,
    ).toEqual(["https://home.example.com", "https://route.test"]);
  });
});
