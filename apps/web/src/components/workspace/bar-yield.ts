import { observeResize } from "@opensteer/shared/resizeObserver";
import { useLayoutEffect, useState, type RefObject } from "react";

/** The least of a name a bar keeps before anything beside it gives way. */
const nameFloor = 64;

/**
 * A bar degrades by design, never by overflow. Its name truncates first, down
 * to a readable floor; past that, the items marked `data-yield="<rank>"` give
 * way in rank order, lowest first, until everything left fits inside the bar.
 * A yielded item carries `data-yielded` and is not drawn. Returns how many
 * ranks have yielded, so what yields can be offered somewhere else.
 */
export function useBarYield(barRef: RefObject<HTMLElement | null>, ranks: number): number {
  const [yielded, setYielded] = useState(0);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const fit = () => {
      let rank = 0;
      yieldTo(bar, rank);
      while (rank < ranks && !fits(bar)) yieldTo(bar, ++rank);
      setYielded(rank);
    };
    let stopResize = () => undefined as void;
    const watch = () => {
      stopResize();
      stopResize = observeResize(
        [bar, ...bar.querySelectorAll(":scope > *, [data-yield-name]")],
        fit,
      );
      fit();
    };
    watch();
    // A name, a count or a picture arriving changes what has to fit; what
    // changes inside a picture's fixed frame never does.
    const changes = new MutationObserver((records) => {
      if (records.some(({ target }) => !insideFrame(target))) watch();
    });
    changes.observe(bar, { characterData: true, childList: true, subtree: true });
    // A face arriving widens the name's text without resizing its box.
    document.fonts?.addEventListener("loadingdone", fit);
    return () => {
      document.fonts?.removeEventListener("loadingdone", fit);
      changes.disconnect();
      stopResize();
    };
  }, [barRef, ranks]);
  return yielded;
}

function insideFrame(node: Node): boolean {
  return (
    (node instanceof Element ? node : node.parentElement)?.closest(".viewfinder__frame") != null
  );
}

function yieldTo(bar: HTMLElement, rank: number) {
  for (const item of bar.querySelectorAll<HTMLElement>("[data-yield]"))
    item.toggleAttribute("data-yielded", Number(item.dataset.yield) <= rank);
}

function fits(bar: HTMLElement): boolean {
  const end = bar.getBoundingClientRect().right;
  for (const child of bar.children)
    if (child.getBoundingClientRect().right > end + 0.5) return false;
  const name = bar.querySelector<HTMLElement>("[data-yield-name]");
  if (name === null) return true;
  // Unrounded: a name short of its text by a fraction of a pixel already shows an ellipsis.
  const text = document.createRange();
  text.selectNodeContents(name);
  const whole = text.getBoundingClientRect().width;
  return name.getBoundingClientRect().width + 0.01 >= Math.min(nameFloor, whole);
}
