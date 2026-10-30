import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BrowserPasskeyBar } from "./browser-passkey-bar.js";
it("shows the RP, explicit Continue and agent notice without a modal", () => {
  const html = renderToStaticMarkup(
    <BrowserPasskeyBar
      state={{ kind: "offer", requestId: "request", rpId: "example.test", agent: true }}
      onContinue={async () => {}}
    />,
  );
  expect(html).toContain("<strong>example.test</strong> wants to use a passkey");
  expect(html).toContain("Continue");
  expect(html).toContain("An agent is working in this tab");
  expect(html).not.toContain('role="dialog"');
});
it("shows the shared notice and no Continue on notice viewers", () => {
  const html = renderToStaticMarkup(
    <BrowserPasskeyBar state={{ kind: "notice" }} onContinue={async () => {}} />,
  );
  expect(html).toContain("Passkeys work when you open this tab in the Opensteer app on your Mac");
  expect(html).not.toContain("<button");
});
