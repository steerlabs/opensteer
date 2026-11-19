/**
 * Transcript rows let the browser skip laying out the ones off screen (`content-visibility`). When
 * a skipped row above the reader is laid out at a height other than the one it stood in for, the
 * engine must hold the reader's place, as scroll anchoring does. Some engines claim
 * `overflow-anchor` yet do not hold it when a row comes out smaller (WebKit 26), so this measures
 * the behaviour itself once and, where the place is not held, turns skipping off: rows are then
 * always laid out and nothing moves under the reader.
 */
export async function checkRowSkipping(document: Document = window.document): Promise<boolean> {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText =
    "position:fixed;left:0;top:0;width:200px;height:120px;overflow:auto;opacity:0;" +
    "pointer-events:none;display:flex;flex-direction:column;";
  for (let index = 0; index < 60; index++) {
    const row = document.createElement("div");
    row.style.cssText =
      "flex:none;content-visibility:auto;contain-intrinsic-block-size:auto 100px;";
    const body = document.createElement("div");
    body.style.height = "30px";
    row.append(body);
    box.append(row);
  }
  document.body.append(box);
  try {
    box.scrollTop = box.scrollHeight;
    await frame();
    await frame();
    box.scrollTop = box.scrollHeight;
    await frame();
    const top = box.getBoundingClientRect().top;
    const anchor = [...box.children].find((row) => row.getBoundingClientRect().top >= top + 20) as
      HTMLElement | undefined;
    if (!anchor) return true;
    let held = true;
    for (let step = 0; step < 3; step++) {
      const was = anchor.getBoundingClientRect().top;
      box.scrollTop -= 20;
      await frame();
      await frame();
      if (Math.abs(anchor.getBoundingClientRect().top - was - 20) > 1) held = false;
    }
    if (!held) document.documentElement.dataset.rowSkipping = "off";
    return held;
  } finally {
    box.remove();
  }
}
