import { describe, expect, test } from "vitest";

import {
  cleanForAction,
  cleanForExtraction,
} from "../../packages/runtime-core/src/sdk/snapshot/cleaner.js";

describe("action snapshot cleaner", () => {
  test("flattens non-clickable descendants inside clickables and unwraps standalone text wrappers", () => {
    const cleaned = cleanForAction(`
      <html>
        <body>
          <button type="button" c="1" data-opensteer-interactive="1">
            <div c="2">
              <div c="3">
                <svg c="4"><use c="5" xlink:href="#pin"></use></svg>
              </div>
              <span c="6">Ship to 92603</span>
            </div>
          </button>
          <div c="7">Standalone filler</div>
          <a href="/product" c="8" data-opensteer-interactive="1">
            <div c="9"><span c="10">Price</span></div>
            <div c="11">Name</div>
          </a>
          <button type="button" c="16" data-opensteer-interactive="1">
            <div c="17"><svg c="18" data-icon="search"><use c="19" xlink:href="#search"></use></svg></div>
          </button>
          <div c="20">Standalone text</div>
        </body>
      </html>
    `);

    expect(cleaned).toMatch(/<button type="button" c="1">\s*Ship to 92603\s*<\/button>/);
    expect(cleaned).toMatch(/<a href="\/product" c="8">\s*Price\s+Name\s*<\/a>/);
    expect(cleaned).toMatch(
      /<button type="button" c="16">\s*<svg(?=[^>]*c="18")(?=[^>]*data-icon="search")[^>]*><\/svg>\s*<\/button>/,
    );
    expect(cleaned).toContain("Standalone text");

    expect(cleaned).not.toContain('<div c="20">');
    expect(cleaned).not.toContain('<div c="2"');
    expect(cleaned).not.toContain('<span c="6"');
    expect(cleaned).not.toContain('<div c="9"');
    expect(cleaned).not.toContain("<use");
  });

  test("truncates serialized action srcset output", () => {
    const srcset = Array.from({ length: 12 }, (_, index) => {
      const width = (index + 1) * 160;
      return `https://cdn.example.com/image-${index}.png?token=${"abc123".repeat(12)}&wid=${width}&qlt=80 ${width}w`;
    }).join(", ");

    const cleaned = cleanForAction(`
      <html>
        <body>
          <a href="/product" c="1" data-opensteer-interactive="1">
            <img
              c="2"
              alt="Long image"
              src="https://cdn.example.com/original.png?wid=1900&qlt=80"
              srcset="${srcset}"
            />
          </a>
        </body>
      </html>
    `);

    const match = cleaned.match(/srcset="([^"]*)"/);
    expect(match).not.toBeNull();
    expect(match?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(160);
    expect(match?.[1]).toContain("image-0.png");
    expect(match?.[1]).toContain("160w");
    expect(match?.[1]).toContain("image-11.png");
    expect(match?.[1]).toContain("1920w");
    expect(match?.[1]).toContain("...");
    expect(match?.[1]).not.toContain("[truncated]");
  });

  test("truncates escaped action attributes by serialized length", () => {
    const noisyUrl = `https://example.com/${`a&b<>`.repeat(140)}`;
    const noisyLabel = `Label ${`<&>`.repeat(120)}`;

    const cleaned = cleanForAction(`
      <html>
        <body>
          <a
            href="${noisyUrl}"
            aria-label="${noisyLabel}"
            c="1"
            data-opensteer-interactive="1"
          >
            Link text
          </a>
        </body>
      </html>
    `);

    const hrefMatch = cleaned.match(/href="([^"]*)"/);
    const ariaLabelMatch = cleaned.match(/aria-label="([^"]*)"/);

    expect(hrefMatch).not.toBeNull();
    expect(ariaLabelMatch).not.toBeNull();
    expect(hrefMatch?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(80);
    expect(ariaLabelMatch?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(150);
    expect(hrefMatch?.[1]).toContain("...");
    expect(hrefMatch?.[1].startsWith("https://example.com/")).toBe(true);
    expect(ariaLabelMatch?.[1].endsWith("...")).toBe(true);
    expect(ariaLabelMatch?.[1]).not.toContain("[truncated]");
  });

  test("strips unavailable iframe markers from public output", () => {
    const html = `
      <html>
        <body>
          <iframe
            c="1"
            data-os-unavailable="iframe"
            data-os-node-id="node-1"
          ></iframe>
          <a
            href="/product"
            c="2"
            data-os-node-id="node-2"
            data-opensteer-interactive="1"
            data-os-unavailable="iframe"
          >
            Open product
          </a>
        </body>
      </html>
    `;

    const actionCleaned = cleanForAction(html);
    const extractionCleaned = cleanForExtraction(html);

    expect(actionCleaned).not.toContain("data-os-unavailable");
    expect(extractionCleaned).not.toContain("data-os-unavailable");
    expect(actionCleaned).toContain('data-os-node-id="node-2"');
    expect(extractionCleaned).toContain('data-os-node-id="node-2"');
  });

  test("truncates serialized extraction URL attributes", () => {
    const noisyHref = `https://example.com/${`a&b<>`.repeat(140)}`;
    const srcset = Array.from({ length: 8 }, (_, index) => {
      const width = (index + 1) * 320;
      return `https://cdn.example.com/image-${index}.png?token=${`<&>`.repeat(70)}&wid=${width} ${width}w`;
    }).join(", ");

    const cleaned = cleanForExtraction(`
      <html>
        <body>
          <a href="${noisyHref}" c="1">Product link</a>
          <img
            c="2"
            alt="Long image"
            src="https://cdn.example.com/original.png?token=${`<&>`.repeat(100)}"
            srcset="${srcset}"
          />
        </body>
      </html>
    `);

    const hrefMatch = cleaned.match(/href="([^"]*)"/);
    const srcMatch = cleaned.match(/src="([^"]*)"/);
    const srcsetMatch = cleaned.match(/srcset="([^"]*)"/);

    expect(hrefMatch).not.toBeNull();
    expect(srcMatch).not.toBeNull();
    expect(srcsetMatch).not.toBeNull();
    expect(hrefMatch?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(80);
    expect(srcMatch?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(80);
    expect(srcsetMatch?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(160);
    expect(hrefMatch?.[1]).toContain("...");
    expect(srcMatch?.[1]).toContain("...");
    expect(srcsetMatch?.[1]).toContain("image-0.png");
    expect(srcsetMatch?.[1]).toContain("320w");
    expect(srcsetMatch?.[1]).toContain("image-7.png");
    expect(srcsetMatch?.[1]).toContain("2560w");
    expect(srcsetMatch?.[1]).toContain("...");
    expect(srcsetMatch?.[1]).not.toContain("[truncated]");
  });

  test("preserves visible descendants from self-hidden wrappers while dropping hidden text", () => {
    const html = `
      <html>
        <body>
          <div c="1" data-opensteer-hidden-self="1">
            Hidden wrapper text
            <span c="2">Visible child</span>
          </div>
          <div c="3" data-opensteer-hidden="1">
            <span c="4">Hidden subtree text</span>
          </div>
          <img
            c="5"
            data-opensteer-hidden-self="1"
            src="https://cdn.example.com/hidden.png"
            alt="Hidden image"
          />
        </body>
      </html>
    `;

    const actionCleaned = cleanForAction(html);
    const extractionCleaned = cleanForExtraction(html);

    expect(actionCleaned).toContain("Visible child");
    expect(extractionCleaned).toContain("Visible child");

    expect(actionCleaned).not.toContain("Hidden wrapper text");
    expect(extractionCleaned).not.toContain("Hidden wrapper text");
    expect(actionCleaned).not.toContain("Hidden subtree text");
    expect(extractionCleaned).not.toContain("Hidden subtree text");
    expect(actionCleaned).not.toContain("Hidden image");
    expect(extractionCleaned).not.toContain("Hidden image");
    expect(actionCleaned).not.toContain("hidden.png");
    expect(extractionCleaned).not.toContain("hidden.png");
  });

  test("merges adjacent extraction text nodes without reordering after comment removal", () => {
    const cleaned = cleanForExtraction(`
      <html>
        <body>
          <div c="1">a<!-- one -->b<!-- two -->c<!-- three -->d</div>
        </body>
      </html>
    `);

    expect(cleaned).toContain('<div c="1">abcd</div>');
    expect(cleaned).not.toContain("abdc");
  });

  test("keeps only aria-label in action snapshots while middle-truncating href and src", () => {
    const cleaned = cleanForAction(`
      <html>
        <body>
          <os-shadow-root data-os-boundary="shadow">
            <button
              c="1"
              data-opensteer-interactive="1"
              aria-label="Search by voice"
              aria-describedby="voice-help"
              aria-expanded="false"
              aria-haspopup="dialog"
            >
              Search
            </button>
            <button c="2" data-opensteer-interactive="1">
              <img
                c="3"
                src="https://cdn.example.com/assets/icons/voice-search/button/large/2x/search-by-voice-asset-with-extra-path.png?token=abcdef1234567890&wid=640&fmt=webp"
                alt="Voice search"
              />
            </button>
          </os-shadow-root>
          <os-iframe-root data-os-boundary="iframe">
            <a
              c="4"
              data-opensteer-interactive="1"
              href="https://shop.example.com/p/apple-airpods-max-2/-/A-1010453160?preselect=black&promo=weekly-sale&ref=homepage-hero"
              aria-label="AirPods Max"
              aria-controls="product-panel"
              aria-describedby="product-desc"
            >
              View product
            </a>
          </os-iframe-root>
        </body>
      </html>
    `);

    expect(cleaned).toContain('aria-label="Search by voice"');
    expect(cleaned).toContain('aria-label="AirPods Max"');
    expect(cleaned).not.toContain("aria-describedby");
    expect(cleaned).not.toContain("aria-expanded");
    expect(cleaned).not.toContain("aria-haspopup");
    expect(cleaned).not.toContain("aria-controls");
    expect(cleaned).toContain("https://cdn.example.com/assets/icons/voi...");
    expect(cleaned).toContain("640&amp;fmt=webp");
    expect(cleaned).toContain("...");
    expect(cleaned).not.toContain(
      "https://cdn.example.com/assets/icons/voice-search/button/large/2x/search-by-voice-asset-with-extra-path.png?token=abcdef1234567890&wid=640&fmt=webp",
    );
    expect(cleaned).toContain("https://shop.example.com/p/apple-airpods");
    expect(cleaned).toContain("age-hero");
    expect(cleaned).toContain('data-os-boundary="shadow"');
    expect(cleaned).toContain('data-os-boundary="iframe"');
  });

  test("removes all aria attributes in extraction snapshots while middle-truncating href and src", () => {
    const cleaned = cleanForExtraction(`
      <html>
        <body>
          <os-shadow-root data-os-boundary="shadow">
            <a
              c="1"
              href="https://shop.example.com/p/apple-airpods-max-2/-/A-1010453160?preselect=black&promo=weekly-sale&ref=homepage-hero"
              aria-label="AirPods Max"
              aria-describedby="product-desc"
            >
              View product
            </a>
          </os-shadow-root>
          <os-iframe-root data-os-boundary="iframe">
            <img
              c="2"
              src="https://cdn.example.com/assets/catalog/products/hero/airpods-max/image-with-extra-long-name.png?token=abcdef1234567890&wid=1200&fmt=webp"
              alt="Hero image"
            />
          </os-iframe-root>
        </body>
      </html>
    `);

    expect(cleaned).not.toContain("aria-label");
    expect(cleaned).not.toContain("aria-describedby");
    expect(cleaned).toContain("https://shop.example.com/p/apple-airpods");
    expect(cleaned).toContain("age-hero");
    expect(cleaned).toContain("https://cdn.example.com/assets/catalog/p...");
    expect(cleaned).toContain("00&amp;fmt=webp");
    expect(cleaned).toContain("...");
    expect(cleaned).toContain('data-os-boundary="shadow"');
    expect(cleaned).toContain('data-os-boundary="iframe"');
  });

  test("does not deduplicate counter-tagged images with the same truncated src", () => {
    const cdnBase = "https://cdn.example.com/products/";
    const suffix = "?qlt=65&fmt=webp&hei=350&wid=350";
    const makeUrl = (uuid: string) => `${cdnBase}${uuid}${suffix}`;

    const cleaned = cleanForExtraction(`
      <html><body>
        <a href="/p/product-1" c="1">
          <img c="2" src="${makeUrl("AAAA1111-bbbb-cccc-dddd-eeee00000001")}" alt="Product 1" />
        </a>
        <a href="/p/product-2" c="3">
          <img c="4" src="${makeUrl("AAAA1111-bbbb-cccc-dddd-eeee00000002")}" alt="Product 2" />
        </a>
        <a href="/p/product-3" c="5">
          <img c="6" src="${makeUrl("AAAA1111-bbbb-cccc-dddd-eeee00000003")}" alt="Product 3" />
        </a>
      </body></html>
    `);

    expect(cleaned).toContain('c="2"');
    expect(cleaned).toContain('c="4"');
    expect(cleaned).toContain('c="6"');
    const imgMatches = [...cleaned.matchAll(/<img\b[^>]*c="[^"]*"[^>]*>/gi)];
    expect(imgMatches).toHaveLength(3);
  });

  test("keeps srcset candidate boundaries intact when truncating data urls", () => {
    const dataCandidate = `data:image/svg+xml;base64,${"PHN2Zz48L3N2Zz4=".repeat(18)}`;
    const cleaned = cleanForExtraction(`
      <html>
        <body>
          <img
            c="1"
            srcset="${dataCandidate} 1x, https://cdn.example.com/assets/catalog/hero-with-an-extra-long-name.png?token=${"abcdef123456".repeat(10)}&fmt=webp 2x"
            alt="Hero"
          />
        </body>
      </html>
    `);

    const srcsetMatch = cleaned.match(/srcset="([^"]*)"/);
    expect(srcsetMatch).not.toBeNull();
    expect(srcsetMatch?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(160);
    expect(srcsetMatch?.[1]).toContain("data:image/svg+xml;base64");
    expect(srcsetMatch?.[1]).toContain("1x");
    expect(srcsetMatch?.[1]).toContain("fmt=webp");
    expect(srcsetMatch?.[1]).toContain("2x");
    expect(srcsetMatch?.[1]).toContain("...");
  });
});
