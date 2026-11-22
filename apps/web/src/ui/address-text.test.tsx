// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AddressText, addressParts } from "./address-text.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("breaks an address, host or URL only at its own joints: after @, before a dot, after /", () => {
  expect(addressParts("tim@example.com")).toEqual(["tim@", "example", ".com"]);
  expect(addressParts("alex.connect.opensteer.invalid")).toEqual([
    "alex",
    ".connect",
    ".opensteer",
    ".invalid",
  ]);
  expect(addressParts("https://claude.ai/api/mcp")).toEqual([
    "https://",
    "claude",
    ".ai/",
    "api/",
    "mcp",
  ]);
  // Not an address: one part, broken nowhere of its own.
  expect(addressParts("Workshop")).toEqual(["Workshop"]);
});

it("draws the addresses in a sentence with break chances at their joints and no hyphens", async () => {
  const element = document.createElement("div");
  const root = createRoot(element);
  await act(async () =>
    root.render(<AddressText text="Send MOCKCODE to tim@example.com in a direct message." />),
  );
  const address = element.querySelector(".address")!;
  expect(address.textContent).toBe("tim@example.com");
  // A break chance after "@" and before ".com", none inside "example".
  expect(address.innerHTML).toBe("tim@<wbr>example<wbr>.com");
  expect(element.textContent).toBe("Send MOCKCODE to tim@example.com in a direct message.");
  act(() => root.unmount());
});
