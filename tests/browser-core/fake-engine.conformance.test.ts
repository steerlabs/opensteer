import { createFakeBrowserCoreEngine } from "../../packages/browser-core/src/index.js";
import { defineBrowserCoreConformanceSuite } from "./conformance-suite.js";

defineBrowserCoreConformanceSuite({
  name: "FakeBrowserCoreEngine conformance",
  createHarness: async () => ({
    engine: createFakeBrowserCoreEngine(),
    urls: {
      initial: "https://example.com/path",
      sameDocument: "https://example.com/path#details",
      crossDocument: "https://example.com/next",
      popup: "https://popup.example.com",
    },
  }),
});
