import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { DesktopDownload, DesktopDownloadsBridge } from "@opensteer/protocol/desktop";
import { formatBytes } from "../../app-model.js";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import { subscribeDownloadFeedback, useDesktopDownloads } from "../../desktop/downloads-store.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { useToast } from "../toast.js";

export function DownloadFeedback() {
  const toast = useToast();
  useEffect(
    () =>
      subscribeDownloadFeedback((download) => {
        if (download.state === "completed") toast.success(`Downloaded ${download.filename}`);
        else toast.error(`Couldn't download ${download.filename}`);
      }),
    [toast],
  );
  return null;
}

function statusLine(download: DesktopDownload) {
  if (download.state === "cancelled") return "Cancelled";
  if (download.state === "failed") return "Failed";
  const bytes = (value: number) => (value === 0 ? "0 B" : formatBytes(value));
  if (download.state === "completed") return bytes(download.receivedBytes);
  return download.totalBytes === null
    ? bytes(download.receivedBytes)
    : `${bytes(download.receivedBytes)} of ${bytes(download.totalBytes)}`;
}

export function BrowserDownloads() {
  const downloads = useDesktopDownloads();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const toast = useToast();
  const bridge = desktopBridge()?.downloads;
  if (!bridge || downloads.length === 0) return null;
  const progressing = downloads.filter((download) => download.state === "progressing");
  const determinate = progressing.every((download) => download.totalBytes !== null);
  const total = progressing.reduce((sum, download) => sum + (download.totalBytes ?? 0), 0);
  const received = progressing.reduce((sum, download) => sum + download.receivedBytes, 0);
  const percent = total > 0 ? Math.min(100, (received / total) * 100) : 0;
  const act = async (
    action: "open" | "show" | "cancel",
    download: DesktopDownload,
    target: DesktopDownloadsBridge,
  ) => {
    try {
      const result = await target[action]({ id: download.id });
      if (result.status === "missing") toast.error(`${download.filename} was moved or deleted`);
      else if (result.status === "failed") toast.error(`Couldn't open ${download.filename}`);
    } catch {
      toast.error(`Couldn't ${action === "cancel" ? "cancel" : "open"} ${download.filename}`);
    }
  };
  return (
    <>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Downloads"
        className={`icon-btn surface-menu browser-downloads${open ? " is-open" : ""}`}
        onClick={() => setOpen(!open)}
        ref={anchor}
        title="Downloads"
        type="button"
      >
        <Icon name="download" />
        {progressing.length ? (
          <span
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={determinate ? percent : undefined}
            className={`browser-downloads__progress${determinate ? "" : " is-indeterminate"}`}
            role="progressbar"
            style={{ "--download-progress": `${percent}%` } as CSSProperties}
          />
        ) : null}
      </button>
      {open && anchor.current ? (
        <Popover
          anchor={anchor.current}
          below
          className="popover--downloads"
          id={panelId}
          label="Downloads"
          onClose={() => setOpen(false)}
          role="dialog"
        >
          <h2 className="browser-downloads__heading">Recent downloads</h2>
          <ul className="browser-downloads__list">
            {downloads.map((download) => (
              <li className="browser-download" key={download.id}>
                {download.state === "completed" ? (
                  <button
                    aria-label={`Open ${download.filename}`}
                    className="browser-download__file"
                    onClick={() => {
                      void act("open", download, bridge);
                    }}
                    type="button"
                  >
                    <DownloadDetails download={download} />
                  </button>
                ) : (
                  <div className="browser-download__file">
                    <DownloadDetails download={download} />
                  </div>
                )}
                {download.state === "completed" ? (
                  <button
                    aria-label={`Show ${download.filename} in Finder`}
                    className="icon-btn"
                    onClick={() => {
                      void act("show", download, bridge);
                    }}
                    title="Show in Finder"
                    type="button"
                  >
                    <Icon name="folder" />
                  </button>
                ) : null}
                {download.state === "progressing" ? (
                  <button
                    aria-label={`Cancel ${download.filename}`}
                    className="icon-btn"
                    onClick={() => {
                      void act("cancel", download, bridge);
                    }}
                    title="Cancel download"
                    type="button"
                  >
                    <Icon name="close" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </>
  );
}

function DownloadDetails({ download }: { readonly download: DesktopDownload }) {
  return (
    <>
      <span className="browser-download__filename" title={download.filename}>
        {download.filename}
      </span>
      <span className="browser-download__status">{statusLine(download)}</span>
      {download.site ? <span className="browser-download__site">{download.site}</span> : null}
    </>
  );
}
