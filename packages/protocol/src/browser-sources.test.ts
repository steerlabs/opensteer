import { BrowserSiteSchema as WireBrowserSiteSchema } from "@opensteer/browser-source-wire/site";
import { BrowserSiteSchema } from "@opensteer/core";
import { expect, it } from "vitest";

// The extension checks sites with the wire package's copy, which cannot import core.
it.each([
  ["https://github.com"],
  ["http://localhost"],
  ["http://127.0.0.1"],
  ["https://[::1]"],
  ["https://my_host.example"],
  ["https://app.vercel.app"],
  ["https://GitHub.com"],
  ["https://github.com/"],
  ["https://github.com:443"],
  ["https://github.com:8443"],
  ["https://gist.github.com/x"],
  ["https://user@github.com"],
  ["ftp://github.com"],
  ["https://*.github.com"],
  ["github.com"],
  [`https://${"a".repeat(300)}.com`],
  [""],
])("the wire and core agree on the site %j", (value) => {
  expect(WireBrowserSiteSchema.safeParse(value).success).toBe(
    BrowserSiteSchema.safeParse(value).success,
  );
});
