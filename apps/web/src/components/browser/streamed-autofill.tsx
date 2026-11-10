import type { BrowserAutofillState } from "@opensteer/client/host";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { AutofillChooser, autofillChooserWidth } from "./autofill-chooser.js";

export interface AutofillFieldBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Between the field and the chooser, and between the chooser and the view's edge. */
const fieldGap = 4;
const viewEdge = 8;

/**
 * Under the field, left-aligned with it, unless the chooser fits only above
 * it or there is more room there. It stays inside the view, and scrolls when
 * neither side holds all of it.
 */
export function autofillPlacement(
  field: AutofillFieldBox,
  view: { readonly width: number; readonly height: number },
  naturalHeight: number,
) {
  const width = Math.max(0, Math.min(view.width - 2 * viewEdge, autofillChooserWidth(field.width)));
  const left = Math.max(viewEdge, Math.min(field.left, view.width - viewEdge - width));
  const below = view.height - viewEdge - (field.top + field.height + fieldGap);
  const above = field.top - fieldGap - viewEdge;
  const side: "below" | "above" = naturalHeight <= below || below >= above ? "below" : "above";
  const maxHeight = Math.max(0, side === "below" ? below : above);
  const height = Math.min(naturalHeight, maxHeight);
  const top =
    side === "below" ? field.top + field.height + fieldGap : field.top - fieldGap - height;
  return { left, top, width, maxHeight, side };
}

/** The chooser over a streamed page, anchored to its field in the view's pixels. */
export function StreamedAutofill({
  autofill,
  field,
  listId,
  onChoose,
  view,
}: {
  readonly autofill: BrowserAutofillState;
  readonly field: AutofillFieldBox;
  readonly listId: string;
  readonly onChoose: (accountId: string) => void;
  readonly view: { readonly width: number; readonly height: number };
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const placement = autofillPlacement(field, view, naturalHeight);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    // Held to its room, it is at least that tall: its content says how much.
    setNaturalHeight(
      element.offsetHeight < placement.maxHeight
        ? element.offsetHeight
        : element.scrollHeight + element.offsetHeight - element.clientHeight,
    );
  });
  return (
    <AutofillChooser
      accounts={autofill.offer.accounts}
      className="autofill-chooser--streamed"
      highlighted={autofill.highlighted}
      key={autofill.offer.offerId}
      listId={listId}
      onChoose={onChoose}
      open={autofill.open && autofill.pending === null}
      ref={panel}
      role={autofill.offer.role}
      side={placement.side}
      style={
        {
          left: placement.left,
          top: placement.top,
          width: placement.width,
          "--autofill-room": `${placement.maxHeight}px`,
        } as CSSProperties
      }
    />
  );
}
