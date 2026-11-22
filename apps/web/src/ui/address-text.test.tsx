import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Address, SentenceText } from "./address-text.js";

it("draws an address as one box per part, joined back to the address exactly", () => {
  const markup = renderToStaticMarkup(<Address value="tim@münchen.de" />);
  expect(markup).toBe(
    '<span class="address"><span class="address__part">tim@</span><span class="address__part">münchen</span><span class="address__part">.de</span></span>',
  );
});

it("draws a sentence's address part as an address and its words as words", () => {
  const markup = renderToStaticMarkup(
    <SentenceText parts={["Send it to ", { address: "foo.xn--p1ai" }, " now."]} />,
  );
  expect(markup).toBe(
    'Send it to <span class="address"><span class="address__part">foo</span><span class="address__part">.xn--p1ai</span></span> now.',
  );
});
