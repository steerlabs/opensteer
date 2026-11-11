import "./placeholder.css";

/** A stand-in window until an agent's real apps are built. */
export function placeholder(name: string, title: string): string {
  return `<div class="win ph is-open is-front" data-win="${name}" style="left:30px;top:30px;width:640px;height:440px">
  <div class="ph-bar"><span class="tl"><i></i><i></i><i></i></span><b>${title}</b></div>
  <div class="ph-body"><p data-h="${name}-line"></p></div>
</div>`;
}
