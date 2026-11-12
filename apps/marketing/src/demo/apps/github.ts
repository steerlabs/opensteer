import "./github.css";
import type { BrowserTab } from "./browser.js";

const MARK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.88.87 2.33.66.07-.52.28-.87.5-1.07-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg>`;

const line = (kind: "" | "del" | "add", before: string, after: string, code: string): string =>
  `<div class="gh-line${kind ? ` gh-line--${kind}` : ""}"><i>${before}</i><i>${after}</i><b>${kind === "del" ? "-" : kind === "add" ? "+" : ""}</b><code>${code}</code></div>`;

/** The pushed commit on GitHub: its message and the one-line change. */
export const github: BrowserTab = {
  id: "github",
  title: "Commits · junipercoffee/shop",
  url: "github.com<em>/junipercoffee/shop/commit/a1b9c3e</em>",
  mark: `<i class="br-fav gh-fav">${MARK}</i>`,
  page: `<div class="gh">
  <header class="gh-top">${MARK}<span>junipercoffee</span><em>/</em><b>shop</b><span class="gh-search">Type <kbd>/</kbd> to search</span><i>AR</i></header>
  <nav class="gh-tabs"><span class="is-on">Code</span><span>Issues <em>3</em></span><span>Pull requests</span><span>Actions</span><span>Settings</span></nav>
  <main class="gh-main">
    <p class="gh-kicker">Commit <code>a1b9c3e</code></p>
    <h4 data-h="gh-title">Send checkout totals in cents</h4>
    <div class="gh-meta"><i>AR</i><b>alexrivera</b> committed now<span class="gh-branch">main</span></div>
    <p class="gh-desc">The payment API takes integer cents. Checkout was sending dollars, so any order with cents in its total was rejected.</p>
    <div class="gh-count"><b>1 file changed</b><span class="gh-add">+1</span><span class="gh-del">-1</span><span>lines changed</span></div>
    <section class="gh-file">
      <header><b>lib/checkout.ts</b><span class="gh-add">+1</span><span class="gh-del">-1</span></header>
      <div class="gh-hunk">@@ -39,7 +39,7 @@ export async function createCharge(order: Order) {</div>
      ${line("", "39", "39", "  const charge = await payments.charges.create({")}
      ${line("del", "40", "", "    amount: order.total,")}
      ${line("add", "", "40", "    amount: Math.round(order.total * 100),")}
      ${line("", "41", "41", '    currency: "usd",')}
      ${line("", "42", "42", "    source: order.cardToken,")}
      ${line("", "43", "43", "    description: `Order #${order.number}`,")}
      ${line("", "44", "44", "  });")}
    </section>
  </main>
</div>`,
};
