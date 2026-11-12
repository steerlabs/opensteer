import "./terminal.css";

const lines = (when: string, text: string): string =>
  `<span class="trm-when trm-when--${when}">${text}</span>`;

/** Terminal running the shop's dev server. Its log grows as scene flags `t-fail`, `t-built` and `t-paid` land. */
export const terminal = `<div class="win trm is-open" data-win="terminal" style="left:890px;top:44px;width:366px;height:430px">
  <div class="trm-bar"><span class="tl"><i></i><i></i><i></i></span><b>shop — npm run dev — 48×25</b></div>
  <pre class="trm-out"><span class="trm-dim">alex@Alexs-MacBook-Air shop %</span> npm run dev

> shop@1.4.0 dev
> next dev

   <b>▲ Next.js 15.3.1</b>
   - Local:    http://localhost:3000

 <span class="trm-ok">✓</span> Ready in 1.2s
 GET /checkout <span class="trm-ok">200</span> in 84ms
${lines("fail", ` <span class="trm-bad">⨯</span> Error: amount must be an integer\n    at createCharge (lib/checkout.ts:40:31)\n POST /api/checkout <span class="trm-bad">500</span> in 38ms\n`)}${lines("built", ` <span class="trm-ok">✓</span> Compiled in 164ms\n`)}${lines("again", ` GET /checkout <span class="trm-ok">200</span> in 31ms\n`)}${lines("paid", ` POST /api/checkout <span class="trm-ok">200</span> in 412ms\n GET /orders/1048 <span class="trm-ok">200</span> in 22ms\n`)}<i class="trm-caret"></i></pre>
</div>`;
