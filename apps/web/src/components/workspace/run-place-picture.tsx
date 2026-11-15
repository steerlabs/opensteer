import {
  emptyRunPlacePicture,
  reportRunPlacePicture,
  type HostClient,
  type RunPlaceDisplay,
  type RunPlacePicture,
} from "@opensteer/client/host";
import { useRunPlaceDisplay } from "@opensteer/client/react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  drawPicture,
  knownPhoneDisplayDecoding,
  phoneDisplayDecoding,
  PhoneDisplayPicture,
  type PhoneDisplayPictureState,
} from "../phone-display-media.js";

/**
 * The last picture a decoder drew, kept across a gap in the display binding so
 * a canvas mounted in the gap, such as the form the place folds into, draws
 * it at once instead of waiting for the next keyframe.
 */
class KeptPicture {
  #held: ReturnType<PhoneDisplayPicture["takePicture"]> = null;

  hold(next: ReturnType<PhoneDisplayPicture["takePicture"]>): void {
    if (this.#held?.picture !== next?.picture) this.#held?.picture.close();
    this.#held = next;
  }

  paint(canvas: HTMLCanvasElement): boolean {
    const held = this.#held;
    if (!held) return false;
    drawPicture(canvas, held.picture, held.width, held.height);
    return true;
  }
}

interface RunPlacePictures {
  readonly picture: RunPlacePicture;
  readonly display: RunPlaceDisplay | null;
  readonly media: PhoneDisplayPicture | null;
  readonly kept: KeptPicture | null;
}

const RunPlacePicturesContext = createContext<RunPlacePictures>({
  picture: emptyRunPlacePicture,
  display: null,
  media: null,
  kept: null,
});

/** The conversation's Run place picture, as its pane-level owner holds it. */
export function useRunPlacePictures(): RunPlacePictures {
  return useContext(RunPlacePicturesContext);
}

/**
 * Gives every form of a conversation's Run place one picture: the shared
 * owner's state, and for a Mac app or phone one decoder, so the head picture,
 * the row and the page hand the same pixels over without a new keyframe.
 * Only this decoder tells the owner when pixels are drawn or gone.
 */
export function RunPlacePictureScope({
  children,
  decoding,
  enabled,
  hostClient,
  picture,
  threadId,
}: {
  readonly children: ReactNode;
  /** How this browser decodes a Mac app or phone; null while unknown or where it cannot. */
  readonly decoding: HardwareAcceleration | null;
  /** Some form of the place is on screen. */
  readonly enabled: boolean;
  readonly hostClient: HostClient;
  readonly picture: RunPlacePicture;
  readonly threadId: string;
}) {
  const display = useRunPlaceDisplay(hostClient, threadId, enabled ? picture.placeKey : null);
  const [media, setMedia] = useState<PhoneDisplayPicture | null>(null);
  const [kept] = useState(() => new KeptPicture());
  const usable = useRef(picture.usable);
  usable.current = picture.usable;
  const placeKey = picture.placeKey;
  useEffect(() => {
    if (display === null || !decoding || placeKey === null) return;
    // The display is the owner's to release; this decoder only reads it.
    const current = new PhoneDisplayPicture({ ...display, release: () => {} }, decoding);
    let reported: PhoneDisplayPictureState["shown"] = null;
    const stop = current.subscribe(() => {
      const { shown, stale } = current.getSnapshot();
      if (shown && !stale) {
        // Only a paint replaces `shown`; decoder bookkeeping keeps the same one.
        if (shown === reported) return;
        reported = shown;
        // Every canvas attached now shows this decoder's own picture.
        kept.hold(null);
        reportRunPlacePicture(hostClient, threadId, placeKey, {
          kind: "drawn",
          width: shown.width,
          height: shown.height,
        });
      } else if (!shown && reported) {
        reported = null;
        reportRunPlacePicture(hostClient, threadId, placeKey, { kind: "cleared" });
      }
    });
    setMedia(current);
    return () => {
      stop();
      // A picture the owner still counts stays on screen until the next one draws over it.
      const last = usable.current ? current.takePicture() : null;
      if (last) kept.hold(last);
      current.dispose(usable.current);
      setMedia((held) => (held === current ? null : held));
    };
  }, [decoding, display, hostClient, kept, placeKey, threadId]);
  // After the decoder's own cleanup, which may hand its picture over on the way out.
  useEffect(() => () => kept.hold(null), [kept]);
  // Pixels the owner stopped counting leave the screen at once.
  const wasUsable = useRef(picture.usable);
  useLayoutEffect(() => {
    if (wasUsable.current && !picture.usable) {
      kept.hold(null);
      media?.clear();
    }
    wasUsable.current = picture.usable;
  }, [kept, media, picture.usable]);
  return (
    <RunPlacePicturesContext value={{ picture, display, media, kept }}>
      {children}
    </RunPlacePicturesContext>
  );
}

/**
 * Whether this browser can decode a Mac app's or phone's picture, asked once
 * per page as soon as one might be shown: null while unknown or where it cannot.
 */
export function useDisplayDecoding(wanted: boolean) {
  const [decoding, setDecoding] = useState(knownPhoneDisplayDecoding);
  useEffect(() => {
    if (!wanted || decoding !== undefined) return;
    let current = true;
    void phoneDisplayDecoding().then((answer) => {
      if (current) setDecoding(answer);
    });
    return () => {
      current = false;
    };
  }, [decoding, wanted]);
  return decoding ?? null;
}

/**
 * A Mac app's or phone's picture, drawn by the conversation's one decoder.
 * A Mac window is asked for no more pixels than this canvas shows. The owner
 * counting a picture is not this canvas having one: until it draws, the
 * canvas stays hidden and says it has nothing, so its frame keeps a cover.
 */
export function RunPlaceCanvas({
  enabled,
  mac,
  onPainted,
  usable,
}: {
  readonly enabled: boolean;
  readonly mac: boolean;
  readonly onPainted?: ((painted: boolean) => void) | undefined;
  readonly usable: boolean;
}) {
  const { display, kept, media } = useRunPlacePictures();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [painted, setPainted] = useState(false);
  useLayoutEffect(() => {
    if (!usable) setPainted(false);
  }, [usable]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;
    if (kept?.paint(canvas)) setPainted(true);
    return media?.attach(canvas, () => setPainted(true));
  }, [enabled, kept, media]);
  useLayoutEffect(() => onPainted?.(painted), [onPainted, painted]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!mac || !enabled || !canvas || !display || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = canvas.getBoundingClientRect();
      const side = Math.max(rect.width, rect.height) * window.devicePixelRatio;
      if (side > 0) display.viewport(side);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [display, enabled, mac]);
  return (
    <canvas
      className={usable && painted ? "place-canvas" : "place-canvas place-canvas--hidden"}
      ref={canvasRef}
    />
  );
}
