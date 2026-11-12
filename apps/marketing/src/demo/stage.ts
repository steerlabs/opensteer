import { find, reducedMotion, restart } from "../dom.js";
import { CROP, PHONE_ONLY, STAGE_SIZE } from "./geometry.js";

export const STAGE = `<p class="stepline" aria-hidden="true"><span class="stepline__bars">${"<i><b></b></i>".repeat(3)}</span><span class="stepline__words"></span></p>
<div class="scene-wrap"><div class="scene">
  <div class="view">
    <div class="floor" aria-hidden="true"></div>
    <!--mac-->
    <!--phone-->
  </div>
</div></div>
<div class="tabs" role="group" aria-label="Pick an agent to watch"></div>`;

export interface Stage {
  /** The opening shot: the phone alone, close up. Turning it off pulls back to both devices. */
  intro(on: boolean): void;
  /** Takes the playing story's three steps and empties their segments. */
  story(beats: readonly string[]): void;
  /** Step `step` starts now and should take about `ms`. Its segment fills toward that estimate, holds short of full, and completes when the next step starts. Past the last step, all are complete. */
  beat(step: number, ms: number): void;
}

/** Scales the stage to its container; below a laptop's width it crops to the phone. */
export function createStage(root: HTMLElement): Stage {
  const wrap = find(root, ".scene-wrap");
  const scene = find(wrap, ".scene");
  const words = find(root, ".stepline__words");
  const bars = [...root.querySelectorAll<HTMLElement>(".stepline__bars i")];
  let story: readonly string[] = [];
  let filling: { readonly bar: HTMLElement; readonly fill: Animation } | null = null;
  /** Ends the running fill where it stands, so the segment eases from there to its resting state. */
  const settle = (): void => {
    if (!filling) return;
    const line = find(filling.bar, "b");
    line.style.transform = getComputedStyle(line).transform;
    filling.fill.cancel();
    void line.offsetWidth;
    line.style.transform = "";
    filling = null;
  };
  const say = (beat: string | undefined): void => {
    if (!beat) return;
    words.textContent = beat;
    restart(words, "is-new");
  };
  const narrow = matchMedia(PHONE_ONLY);
  const fit = (): void => {
    const scale = wrap.clientWidth / (narrow.matches ? CROP.width : STAGE_SIZE.width);
    scene.style.transform = narrow.matches
      ? `scale(${scale}) translate(${-CROP.x}px, ${-CROP.y}px)`
      : `scale(${scale})`;
  };
  new ResizeObserver(fit).observe(wrap);
  fit();
  return {
    intro(on) {
      wrap.toggleAttribute("data-intro", on);
    },
    story(beats) {
      filling?.fill.cancel();
      filling = null;
      story = beats;
      bars.forEach((bar) => {
        bar.dataset.state = "next";
      });
      say(beats[0]);
    },
    beat(at, ms) {
      settle();
      bars.forEach((bar, index) => {
        const state = index + 1 < at ? "done" : index + 1 === at ? "now" : "next";
        if (state === "now" && bar.dataset.state !== "now") {
          const full = reducedMotion ? 1 : 0.9;
          const fill = find(bar, "b").animate(
            [{ transform: "scaleX(0)" }, { transform: `scaleX(${full})` }],
            { duration: reducedMotion ? 0 : ms, fill: "forwards" },
          );
          filling = { bar, fill };
          if (index > 0) say(story[index]);
        }
        bar.dataset.state = state;
      });
    },
  };
}
