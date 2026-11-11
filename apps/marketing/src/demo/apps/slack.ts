import "./slack.css";

const message = (who: string, color: string, time: string, text: string, extra = ""): string =>
  `<article class="sl-msg${extra}"><i style="--v:${color}">${who
    .split(" ")
    .map((word) => word[0])
    .join("")}</i><div><b>${who}</b><time>${time}</time><p>${text}</p></div></article>`;

export const slack = `<div class="win sl" data-win="slack" style="left:120px;top:76px;width:570px;height:440px">
  <div class="sl-top"><span class="tl"><i></i><i></i><i></i></span><span class="sl-search">Search Rivera &amp; Co.</span></div>
  <div class="sl-body">
    <aside class="sl-side">
      <h6>Rivera &amp; Co.</h6>
      <div>Threads</div><div>Drafts &amp; sent</div>
      <h6 class="sl-side__group">Channels</h6>
      <div># general</div><div class="is-on"># support</div><div># engineering</div><div># sales</div>
      <h6 class="sl-side__group">Direct messages</h6>
      <div><i class="sl-dot"></i>Maya Chen</div><div><i class="sl-dot"></i>Sam Okafor</div>
    </aside>
    <section class="sl-main">
      <header><b># support</b><span>Customer issues and escalations</span></header>
      <div class="sl-thread">
        ${message("Maya Chen", "#c58af9", "9:12 AM", "Heads up: Northwind renews next month. Let's keep them happy.")}
        ${message("Sam Okafor", "#3f9a6b", "9:30 AM", "Queue is at 6 open tickets. I'm on the two SSO ones.")}
        ${message("Alex Rivera", "#8a6d5e", "9:43 AM", `<span data-h="sl-posted"></span>`, " sl-msg--new")}
      </div>
      <div class="sl-composer"><p data-h="sl-compose"></p><div><i></i><i></i><i></i><i></i><span class="sl-send">➤</span></div></div>
    </section>
  </div>
</div>`;
