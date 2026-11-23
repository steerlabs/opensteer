import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Address, SentenceText } from "./address-text.js";

const box = (part: string) => `<span class="address__part">${part}</span>`;

it("draws an address as one box per part, isolated, joined back to the address exactly", () => {
  const markup = renderToStaticMarkup(<Address value="tim@münchen.de" />);
  expect(markup).toBe(`<bdi class="address">${box("tim@")}${box("münchen")}${box(".de")}</bdi>`);
});

it("draws a sentence's address part as an address and its words as words", () => {
  const markup = renderToStaticMarkup(
    <SentenceText parts={["Send it to ", { address: "foo.xn--p1ai" }, " now."]} />,
  );
  expect(markup).toBe(
    `Send it to <bdi class="address">${box("foo")}${box(".xn--p1ai")}</bdi> now.`,
  );
});

it.each([
  ["a name that looks like a host", "evil-google.com", "evil-google.com"],
  ["a name that looks like an email address", "alice@evil.example", "alice@evil.example"],
  [
    "a name that imitates Opensteer's words",
    "Work, who may use everything",
    "Work, who may use everything",
  ],
  ["a name the Home cleaned of a right-to-left override", "Alice evol", "Alice evol"],
])("draws %s as a name, in its own weight, never as an address", (_what, name, shown) => {
  const markup = renderToStaticMarkup(
    <SentenceText parts={["Uses ", { name }, " to reach ", { address: "api.example.com" }, "."]} />,
  );
  expect(markup).toBe(
    `Uses “<bdi class="outside-name">${shown.replaceAll("&", "&amp;")}</bdi>” to reach <bdi class="address">${box("api")}${box(".example")}${box(".com")}</bdi>.`,
  );
});

it("leaves a standalone outside name unquoted", () => {
  expect(renderToStaticMarkup(<SentenceText parts={[{ name: "Slack · #team" }]} />)).toBe(
    `<bdi class="outside-name">Slack · #team</bdi>`,
  );
});

it.each([
  ["a soft hyphen inside a host", "evil\u00ADgoogle.com", [box("evilgoogle"), box(".com")]],
  ["a zero-width space inside a host", "evil\u200Bgoogle.com", [box("evilgoogle"), box(".com")]],
  [
    "a right-to-left override",
    "evil.example/\u202Emoc.elgoog",
    [box("evil"), box(".example"), box("/moc"), box(".elgoog")],
  ],
])("draws an address with %s cleaned, breaking only at its own joints", (_what, address, boxes) => {
  expect(renderToStaticMarkup(<Address value={address} />)).toBe(
    `<bdi class="address">${boxes.join("")}</bdi>`,
  );
});
