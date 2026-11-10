import { z } from "zod";
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

export function autofillKey(
  input: { type: string; key: string },
  shown: boolean,
  focused: boolean,
): { forward: boolean; prevent: boolean } {
  const forward = shown && focused && input.type === "keyDown";
  return {
    forward,
    prevent: forward && ["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(input.key),
  };
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
