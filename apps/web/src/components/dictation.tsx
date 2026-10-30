import { useFocusRescue } from "./workspace/occupant-marks.js";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  useRef,
  type ReactNode,
} from "react";
import {
  DictationController,
  dictationDownloadStatus,
  dictationElapsed,
  dictationLabels,
  dictationView,
  type DictationView,
  type DictationSnapshot,
} from "@opensteer/client/dictation";
import { Icon } from "./icon.js";

export const DictationContext = createContext<DictationController | null>(null);
const absent: DictationSnapshot = {
  availability: null,
  language: null,
  phase: "idle",
  owner: null,
  preview: null,
  progress: null,
  startedAt: null,
  listeningSince: null,
  notice: null,
};
const noSubscribe = () => () => {};
const absentSnapshot = () => absent;
export function useDictation() {
  const controller = useContext(DictationContext);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? absentSnapshot,
  );
  return { controller, snapshot };
}

export function DictationStatus({
  controller,
  snapshot,
  owner,
  returnFocusTo,
}: {
  controller: DictationController;
  snapshot: DictationSnapshot;
  owner: string;
  returnFocusTo: { readonly current: HTMLTextAreaElement | null };
}) {
  const view = dictationView(snapshot, owner);
  const active = view.phase !== "idle";
  const notice = view.notice;
  const previousActive = useRef(active);
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (previousActive.current && !active && !notice) setStopped(true);
    else if (active || notice) setStopped(false);
    previousActive.current = active;
  }, [active, notice]);
  const announcement =
    notice?.message ??
    (active
      ? view.phase === "starting"
        ? dictationLabels.starting
        : view.phase === "finishing"
          ? dictationLabels.finishing
          : view.phase === "downloading"
            ? dictationDownloadStatus(view.languageName ?? "", null)
            : dictationLabels.listening
      : stopped
        ? dictationLabels.stopped
        : "");
  return (
    <>
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {notice ? (
        <FocusRow key={notice.kind} returnFocusTo={returnFocusTo}>
          <Icon name="alert-circle" />
          <span className="dictation-status__copy">{notice.message}</span>
          {notice.action ? (
            <button
              className="btn btn--small"
              type="button"
              onClick={() => controller.openMicrophoneSettings()}
            >
              {dictationLabels.openSettings}
            </button>
          ) : null}
          <button
            className="icon-btn"
            type="button"
            aria-label={dictationLabels.dismissNotice}
            onClick={() => controller.dismissNotice()}
          >
            <Icon name="close" />
          </button>
        </FocusRow>
      ) : null}
    </>
  );
}
export function DictationLive({
  controller,
  view,
  onCancel,
  returnFocusTo,
}: {
  controller: DictationController;
  view: DictationView;
  onCancel: () => void;
  returnFocusTo: { readonly current: HTMLTextAreaElement | null };
}) {
  return (
    <FocusRow returnFocusTo={returnFocusTo} live>
      {view.phase === "listening" ? (
        <>
          <LevelMeter controller={controller} />
          <Elapsed since={view.listeningSince!} />
        </>
      ) : (
        <span
          className="dictation-status__copy"
          title={
            view.phase === "downloading"
              ? dictationDownloadStatus(view.languageName ?? "", view.progress)
              : undefined
          }
        >
          <span className="dictation-live__full">
            {view.phase === "downloading"
              ? `Downloading ${view.languageName ?? ""}…`
              : view.phase === "starting"
                ? dictationLabels.starting
                : dictationLabels.finishing}
          </span>
          <span className="dictation-live__compact">
            {view.phase === "downloading"
              ? "↓"
              : view.phase === "starting"
                ? "Starting"
                : "Finishing"}
          </span>
        </span>
      )}
      {view.phase === "downloading" && view.progress !== null ? (
        <span className="dictation-progress">{Math.round(view.progress * 100)}%</span>
      ) : null}
      <button
        className="icon-btn"
        type="button"
        aria-label={
          view.phase === "downloading" ? dictationLabels.cancelDownload : dictationLabels.cancel
        }
        title={
          view.phase === "downloading" ? dictationLabels.cancelDownload : dictationLabels.cancel
        }
        onClick={onCancel}
      >
        <Icon name="close" />
      </button>
    </FocusRow>
  );
}
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="dictation-status__timer" aria-label="Dictation duration">
      {dictationElapsed(now - since)}
    </span>
  );
}
function LevelMeter({ controller }: { controller: DictationController }) {
  const [level, setLevel] = useState(0);
  useEffect(() => controller.subscribeLevel(setLevel), [controller]);
  return (
    <span className="dictation-level" aria-hidden="true">
      {[0.45, 0.8, 1, 0.8, 0.45].map((scale, index) => (
        <i key={index} style={{ height: `${3 + level * scale * 15}px` }} />
      ))}
    </span>
  );
}

function FocusRow({
  children,
  returnFocusTo,
  live = false,
}: {
  live?: boolean;
  children: ReactNode;
  returnFocusTo: { readonly current: HTMLTextAreaElement | null };
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const fallback = useRef(() => returnFocusTo.current);
  useFocusRescue(ref, fallback);
  return (
    <div ref={ref} className={live ? "dictation-live" : "dictation-status"}>
      {children}
    </div>
  );
}
