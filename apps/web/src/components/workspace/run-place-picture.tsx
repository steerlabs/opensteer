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
  knownPhoneDisplayDecoding,
  phoneDisplayDecoding,
  PhoneDisplayPicture,
} from "../phone-display-media.js";

interface RunPlacePictures {
  readonly picture: RunPlacePicture;
  readonly display: RunPlaceDisplay | null;
  readonly media: PhoneDisplayPicture | null;
}

const RunPlacePicturesContext = createContext<RunPlacePictures>({
  picture: emptyRunPlacePicture,
  display: null,
  media: null,
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
  enabled,
  hostClient,
  picture,
  threadId,
}: {
  readonly children: ReactNode;
  /** Some form of the place is on screen. */
  readonly enabled: boolean;
  readonly hostClient: HostClient;
  readonly picture: RunPlacePicture;
  readonly threadId: string;
}) {
  const display = useRunPlaceDisplay(hostClient, threadId, enabled ? picture.placeKey : null);
  const decoding = useDecoding(display !== null);
  const [media, setMedia] = useState<PhoneDisplayPicture | null>(null);
  const usable = useRef(picture.usable);
  usable.current = picture.usable;
  const placeKey = picture.placeKey;
  useEffect(() => {
    if (display === null || !decoding || placeKey === null) return;
    // The display is the owner's to release; this decoder only reads it.
    const current = new PhoneDisplayPicture({ ...display, release: () => {} }, decoding);
    let drawn = false;
    const stop = current.subscribe(() => {
      const shown = current.getSnapshot().shown;
      if (shown) {
        drawn = true;
        reportRunPlacePicture(hostClient, threadId, placeKey, {
          kind: "drawn",
          width: shown.width,
          height: shown.height,
        });
      } else if (drawn) {
        drawn = false;
        reportRunPlacePicture(hostClient, threadId, placeKey, { kind: "cleared" });
      }
    });
    setMedia(current);
    return () => {
      stop();
      // A picture the owner still counts stays on screen until the next one draws over it.
      current.dispose(usable.current);
      setMedia((held) => (held === current ? null : held));
    };
  }, [decoding, display, hostClient, placeKey, threadId]);
  // Pixels the owner stopped counting leave the screen at once.
  const wasUsable = useRef(picture.usable);
  useLayoutEffect(() => {
    if (wasUsable.current && !picture.usable) media?.clear();
    wasUsable.current = picture.usable;
  }, [media, picture.usable]);
  return (
    <RunPlacePicturesContext value={{ picture, display, media }}>
      {children}
    </RunPlacePicturesContext>
  );
}

function useDecoding(wanted: boolean) {
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
 * A Mac window is asked for no more pixels than this canvas shows.
 */
export function RunPlaceCanvas({
  enabled,
  mac,
  usable,
}: {
  readonly enabled: boolean;
  readonly mac: boolean;
  readonly usable: boolean;
}) {
  const { display, media } = useRunPlacePictures();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !media || !enabled) return;
    return media.attach(canvas);
  }, [enabled, media]);
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
      className={usable ? "place-canvas" : "place-canvas place-canvas--hidden"}
      ref={canvasRef}
    />
  );
}
