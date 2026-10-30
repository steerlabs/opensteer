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
  type DictationSnapshot,
} from "@opensteer/client/dictation";
import { Icon } from "./icon.js";

export const DictationContext = createContext<DictationController | null>(null);
const absent: DictationSnapshot = {
  availability: null,
  phase: "idle",
  owner: null,
  preview: null,
  progress: null,
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
  onCancel,
  returnFocusTo,
}: {
  controller: DictationController;
  snapshot: DictationSnapshot;
  owner: string;
  onCancel: () => void;
  returnFocusTo: { readonly current: HTMLTextAreaElement | null };
}) {
  const active = snapshot.owner === owner && snapshot.phase !== "idle";
  const notice = snapshot.notice?.owner === owner ? snapshot.notice : null;
  const language = snapshot.availability?.available ? snapshot.availability.languageName : "";
  const announcement =
    notice?.message ??
    (active
      ? snapshot.phase === "starting"
        ? dictationLabels.starting
        : snapshot.phase === "finishing"
          ? dictationLabels.finishing
          : snapshot.phase === "downloading"
            ? dictationDownloadStatus(language, null)
            : dictationLabels.listening
      : "");
  return (
    <>
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {active ? (
        <FocusRow key={snapshot.phase} returnFocusTo={returnFocusTo}>
          {snapshot.phase === "starting" ||
          snapshot.phase === "finishing" ||
          snapshot.phase === "downloading" ? (
            <span className="spinner" aria-hidden="true" />
          ) : null}
          {snapshot.phase === "listening" ? (
            <>
              <LevelMeter controller={controller} />
              <Elapsed since={snapshot.listeningSince!} />
            </>
          ) : (
            <span className="dictation-status__copy">
              {snapshot.phase === "downloading"
                ? dictationDownloadStatus(language, snapshot.progress)
                : snapshot.phase === "starting"
                  ? dictationLabels.starting
                  : dictationLabels.finishing}
            </span>
          )}
          {snapshot.phase === "listening" ? (
            <button
              className="btn btn--small"
              type="button"
              aria-label={dictationLabels.stop}
              onClick={() => void controller.stop()}
            >
              <Icon name="stop" />
              {dictationLabels.stopButton}
            </button>
          ) : null}
          {snapshot.phase !== "finishing" ? (
            <button
              className={snapshot.phase === "listening" ? "icon-btn" : "btn btn--small"}
              type="button"
              aria-label={
                snapshot.phase === "downloading"
                  ? dictationLabels.cancelDownload
                  : dictationLabels.cancel
              }
              title={
                snapshot.phase === "downloading"
                  ? dictationLabels.cancelDownload
                  : dictationLabels.cancel
              }
              onClick={onCancel}
            >
              {snapshot.phase === "listening" ? (
                <Icon name="close" />
              ) : snapshot.phase === "downloading" ? (
                dictationLabels.cancelDownload
              ) : (
                dictationLabels.cancelStarting
              )}
            </button>
          ) : null}
        </FocusRow>
      ) : null}
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
}: {
  children: ReactNode;
  returnFocusTo: { readonly current: HTMLTextAreaElement | null };
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const fallback = useRef(() => returnFocusTo.current);
  useFocusRescue(ref, fallback);
  return (
    <div ref={ref} className="dictation-status">
      {children}
    </div>
  );
}
