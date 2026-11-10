import { z } from "zod";
import { autofillKeeps } from "@opensteer/client/editing";
import {
  desktopAutofillPopupInset,
  type DesktopAutofillScene,
  type DesktopWindowRect,
} from "@opensteer/protocol/desktop";

export const autofillMeasurementSchema = z.strictObject({
  sceneRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  width: z.number().finite().positive().max(4_096),
  height: z.number().finite().positive().max(4_096),
});
export const autofillChoiceSchema = z.strictObject({
  sceneRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  accountId: z.uuid(),
});

export class AutofillSceneState {
  #revision = -1;
  scene: DesktopAutofillScene | null = null;

  set(scene: DesktopAutofillScene | null): boolean {
    if (
      scene &&
      (scene.sceneRevision < this.#revision ||
        (!this.scene && scene.sceneRevision === this.#revision))
    )
      return false;
    this.scene = scene;
    if (scene) this.#revision = scene.sceneRevision;
    return true;
  }

  acceptsChoice(sceneRevision: number, accountId: string): boolean {
    return (
      this.scene?.sceneRevision === sceneRevision &&
      this.scene.accounts.some((account) => account.id === accountId)
    );
  }
}

/**
 * Which page keys the chooser takes. A press it took stays its own until
 * release, repeats included, even after the chooser has closed, so the page
 * never sees half of it. Losing focus can swallow a release; `reset` then.
 */
export class AutofillKeys {
  readonly #taken = new Set<string>();

  decide(
    input: {
      type: string;
      key: string;
      code: string;
      alt?: boolean;
      control?: boolean;
      meta?: boolean;
      shift?: boolean;
    },
    shown: boolean,
    focused: boolean,
  ): { forward: boolean; prevent: boolean } {
    if (input.type === "keyUp") return { forward: false, prevent: this.#taken.delete(input.code) };
    const forward = shown && focused && input.type === "keyDown";
    const prevent =
      this.#taken.has(input.code) ||
      (forward &&
        autofillKeeps({
          key: input.key,
          alt: input.alt === true,
          ctrl: input.control === true,
          meta: input.meta === true,
          shift: input.shift === true,
        }));
    if (prevent) this.#taken.add(input.code);
    return { forward, prevent };
  }

  reset(): void {
    this.#taken.clear();
  }
}

/** All rectangles are DIPs except the page anchor and the popup's measured CSS size. */
export function autofillPlacement(input: {
  anchor: DesktopWindowRect;
  page: DesktopWindowRect;
  stage: DesktopWindowRect;
  pageZoom: number;
  appZoom: number;
  panel: { width: number; height: number };
}): DesktopWindowRect | null {
  const { anchor, page, stage, pageZoom, appZoom, panel } = input;
  const left = Math.max(stage.x, page.x);
  const top = Math.max(stage.y, page.y);
  const right = Math.min(stage.x + stage.width, page.x + page.width);
  const bottom = Math.min(stage.y + stage.height, page.y + page.height);
  const field = {
    x: page.x + anchor.x * pageZoom,
    y: page.y + anchor.y * pageZoom,
    width: anchor.width * pageZoom,
    height: anchor.height * pageZoom,
  };
  if (
    right <= left ||
    bottom <= top ||
    field.x + field.width <= left ||
    field.x >= right ||
    field.y + field.height <= top ||
    field.y >= bottom
  )
    return null;
  const width = panel.width * appZoom;
  const height = panel.height * appZoom;
  const inset = desktopAutofillPopupInset * appZoom;
  const gap = 4 * pageZoom;
  const below = field.y + field.height + gap;
  const y = below + height <= bottom ? below : Math.max(top, field.y - gap - height);
  const x = Math.max(left, Math.min(field.x, right - width));
  return {
    x: Math.round(x - inset),
    y: Math.round(y - inset),
    width: Math.ceil(width + 2 * inset),
    height: Math.ceil(height + 2 * inset),
  };
}
