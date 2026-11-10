import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  desktopAutofillPopupInset,
  type DesktopAutofillScene,
  type OpensteerAutofillPopupBridge,
} from "@opensteer/protocol/desktop";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { AutofillChooser, autofillChooserWidth } from "./components/browser/autofill-chooser.js";
import "@fontsource-variable/inter/wght.css";
import "./styles/index.css";
import "./styles/autofill-popup.css";

declare global {
  interface Window {
    readonly opensteerAutofill?: OpensteerAutofillPopupBridge;
  }
}

/** The desktop's popup under a native page's field: the scene in, sizes and choices out. */
function AutofillPopup() {
  const [scene, setScene] = useState<DesktopAutofillScene | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => window.opensteerAutofill?.onScene(setScene), []);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !scene) return;
    // Main shows each scene only once it knows the panel's size for it.
    const measure = () =>
      window.opensteerAutofill?.measured({
        sceneRevision: scene.sceneRevision,
        width: element.offsetWidth,
        height: element.offsetHeight,
      });
    measure();
    return observeResize([element], measure);
  }, [scene]);
  if (!scene) return null;
  return (
    <div className="autofill-popup" style={{ padding: desktopAutofillPopupInset }}>
      <AutofillChooser
        accounts={scene.accounts}
        highlighted={scene.highlighted}
        listId={listId}
        onChoose={(accountId) =>
          window.opensteerAutofill?.choose({ sceneRevision: scene.sceneRevision, accountId })
        }
        ref={panel}
        role={scene.role}
        still={scene.reducedMotion}
        style={{ width: autofillChooserWidth(scene.anchor.width) }}
      />
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Opensteer autofill root was not found.");
createRoot(root).render(<AutofillPopup />);
