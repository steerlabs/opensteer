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

    expect(cleaned).not.toContain("<div c=\"20\">");
    expect(cleaned).not.toContain('<div c="2"');
    expect(cleaned).not.toContain('<span c="6"');
    expect(cleaned).not.toContain('<div c="9"');
    expect(cleaned).not.toContain("<use");
  });

  test("truncates serialized action srcset output", () => {
    const srcset = Array.from({ length: 8 }, (_, index) => {
      const width = (index + 1) * 16;
      return `https://cdn.example.com/image-${index}.png?wid=${width}&qlt=80 ${width}w`;
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
    expect(match?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(500);
  });

  test("truncates escaped action attributes by serialized length", () => {
    const noisyUrl = `https://example.com/${`a&b<>"`.repeat(120)}`;
    const noisyLabel = `Label ${`<&">`.repeat(80)}`;

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
    expect(hrefMatch?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(500);
    expect(ariaLabelMatch?.[1].length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(150);
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
});
