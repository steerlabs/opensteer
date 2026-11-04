import { describe, expect, it } from "vitest";
import { avatar, bridge, renderBrowserPage, statusPageBody } from "./browserPage.js";

describe("server-rendered browser pages", () => {
  it("escapes every word a person or a peer chose", () => {
    const page = renderBrowserPage({
      body: statusPageBody({
        action: { href: '/"><script>', label: "<b>Back</b>" },
        detail: "a & b",
        mark: "check",
        title: "</title><script>alert(1)</script>",
        tone: "ok",
      }),
      fonts: { display: '/f/"d.woff2', sans: "/f/s.woff2" },
      layout: "plain",
      preconnect: 'https://a.test/"><script>',
      title: "</title><script>",
    });
    expect(page).not.toMatch(/<script/iu);
    expect(page).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(page).toContain("a &amp; b");
    expect(page).toContain('href="/&quot;&gt;&lt;script&gt;"');
    expect(page).toContain('url("/f/%22d.woff2")');

    const joined = bridge({
      from: avatar("<x>"),
      fromCaption: '"><img src=x>',
      knot: "link",
      to: avatar(""),
    });
    expect(joined).not.toContain("<img");
    expect(joined).toContain(">&lt;</span>");
    expect(joined).toContain(">?</span>");
  });

  it("draws a person's initial from the first character, not the first code unit", () => {
    expect(avatar("éva")).toContain(">É</span>");
    expect(avatar("😀 Smile")).toContain(">😀</span>");
    expect(avatar("  tim@example.test")).toContain(">T</span>");
  });

  it("asks for fonts only when the server serves them", () => {
    const without = renderBrowserPage({ body: "", layout: "card", title: "t" });
    expect(without).not.toContain("@font-face");
    expect(without).not.toContain('rel="preload"');
    const withFonts = renderBrowserPage({
      body: "",
      fonts: { display: "/fonts/d.woff2", sans: "/fonts/s.woff2" },
      layout: "card",
      title: "t",
    });
    expect(withFonts.match(/rel="preload"[^>]*crossorigin/gu)).toHaveLength(2);
    expect(withFonts).toContain("font-display:optional");
  });

  /**
   * A custom property that resolves to nothing silently drops the whole
   * declaration — a lost background, rim or size — so every `var()` without a
   * fallback must name a property the stylesheet declares.
   */
  it("only references custom properties it declares", () => {
    const css = renderBrowserPage({ body: "", layout: "app", title: "t" }).match(
      /<style>([\s\S]*)<\/style>/u,
    )?.[1];
    if (!css) throw new Error("The page carries no stylesheet");
    const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/gu)].map((match) => match[1]));
    const missing = [...css.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/gu)]
      .filter(([, name, fallback]) => fallback === undefined && !declared.has(name))
      .map(([, name]) => name);
    expect([...new Set(missing)]).toEqual([]);
  });
});
