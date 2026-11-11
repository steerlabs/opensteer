import "./qa.css";

const check = (n: number, label: string, result: string): string =>
  `<li class="qa-check qa-check--${n}"${n === 5 ? ` data-h="qa-fail"` : ""}><i></i><span${n === 1 ? ` data-h="qa-c1"` : ""}>${label}</span><em>${result}</em></li>`;

/** A floating test-run panel: the release checklist the agent works through in Till. */
export const qa = `<div class="win qa is-open is-front" data-win="qa" style="left:0;top:204px;width:248px;height:332px">
  <div class="qa-bar"><span class="tl"><i></i><i></i><i></i></span><b>Release 2.4 · Checkout</b></div>
  <div class="qa-head"><span data-h="qa-run">Run 1 · build 411</span><span class="qa-go" data-h="qa-go"><span class="qa-go__idle"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10 6Z" fill="currentColor"/></svg>Run</span><span class="qa-go__busy">Running</span></span></div>
  <ol class="qa-list">
    ${check(1, "Launch 2.4 (411)", "0.9s")}
    ${check(2, "New order", "#1048")}
    ${check(3, "Add 3 items", "$101.00")}
    ${check(4, "10% discount", "−$10.10")}
    ${check(5, "Tax at checkout", "$8.64")}
    <li class="qa-detail"><span>Expected <b>$8.64</b>, got <b class="qa-bad">$8.63</b></span><code>9.5% × $90.90 = $8.6355</code></li>
    ${check(6, "Charge and receipt", "$99.54")}
  </ol>
  <div class="qa-fix"><i></i><span data-h="qa-fix"></span></div>
  <footer class="qa-foot">
    <span class="qa-bars"><i></i><i></i><i></i><i></i><i></i><i></i></span>
    <span class="qa-say qa-say--idle">6 checks · not run yet</span>
    <span class="qa-say qa-say--run">Running checks…</span>
    <span class="qa-say qa-say--fail">1 of 6 failed</span>
    <span class="qa-say qa-say--ship" data-h="qa-ship"><svg><use href="#i-check"/></svg>2.4 is ready to ship</span>
  </footer>
</div>`;
