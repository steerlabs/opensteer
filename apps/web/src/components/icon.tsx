import type { SVGProps } from "react";

/** Hand-drawn 24×24 stroke icon set; sized by the surrounding CSS. */
const paths = {
  microphone: (
    <>
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
    </>
  ),
  "microphone-off": (
    <>
      <path d="M15 9.4V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1" />
      <path d="M19 10v2a7 7 0 0 1-.9 3.4M5 10v2a7 7 0 0 0 11.5 5.4M12 19v3m-4 0h8M3 3l18 18" />
    </>
  ),
  waveform: <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />,
  activity: <path d="M22 12h-4l-3 8L9 4l-3 8H2" />,
  "alert-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4.5M12 15.8v.2" />
    </>
  ),
  "arrow-left": <path d="M19 12H5m6-7-7 7 7 7" />,
  "arrow-right": <path d="M5 12h14m-6-7 7 7-7 7" />,
  "arrow-up": <path d="M12 19V5m-7 7 7-7 7 7" />,
  asterisk: <path d="M12 4.5v15M5.5 8.2l13 7.6m0-7.6-13 7.6" />,
  bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
  brain: (
    <>
      <path d="M12 4.5a3 3 0 0 0-5.6 1.2A3.4 3.4 0 0 0 4 9a3.4 3.4 0 0 0 .6 5.4A3.4 3.4 0 0 0 8 19.5c1.2 1 2.9 1 4 0V4.5Z" />
      <path d="M12 4.5a3 3 0 0 1 5.6 1.2A3.4 3.4 0 0 1 20 9a3.4 3.4 0 0 1-.6 5.4 3.4 3.4 0 0 1-3.4 5.1c-1.2 1-2.9 1-4 0" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9h18M7 6.6h.2" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5L19.5 7" />,
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.4 12.4 2.4 2.4 4.8-5" />
    </>
  ),
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 6-6 6 6 6" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  cloud: <path d="M17.5 18.5a4.5 4.5 0 0 0 .4-9A6 6 0 0 0 6.2 8.3 4.8 4.8 0 0 0 7 18.5h10.5Z" />,
  code: <path d="m8.5 7-5 5 5 5m7-10 5 5-5 5" />,
  collapse: <path d="M9 4v16M4 4h16v16H4V4Z" />,
  command: (
    <path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9Zm0 0v6m0-6h6m-6 6H6.5A2.5 2.5 0 1 0 9 17.5V15Zm6-6V6.5A2.5 2.5 0 1 1 17.5 9H15Zm0 0v6m0 0h2.5a2.5 2.5 0 1 1-2.5 2.5V15Z" />
  ),
  "corner-down-right": <path d="M5 5v5.5a4 4 0 0 0 4 4h10.5m-4.5-4.5 4.5 4.5-4.5 4.5" />,
  compact: (
    <>
      <rect x="3" y="8.2" width="18" height="7.6" rx="2.6" />
      <path d="M6.9 12h.01M7 18.6h10" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  cursor: <path d="M5.5 4.6 18.8 10l-5.9 2.1-2.1 5.9L5.5 4.6Z" />,
  desktop: (
    <>
      <rect x="3" y="3.8" width="18" height="12.6" rx="2.2" />
      <path d="M12 16.4v3.6M8.5 20.2h7" />
    </>
  ),
  "monitor-off": (
    <>
      <path d="M8 3.8h11a2 2 0 0 1 2 2v8.6a2 2 0 0 1-1.6 2M15.5 16.4H5a2 2 0 0 1-2-2V5.8a2 2 0 0 1 .7-1.5" />
      <path d="M12 16.4v3.6M8.5 20.2h7M3 2.5l18 19" />
    </>
  ),
  devices: (
    <>
      <rect x="2.5" y="5" width="12.5" height="9" rx="1.6" />
      <path d="M1.5 17.6h10" />
      <rect x="15.8" y="7.6" width="6.2" height="12" rx="1.7" />
    </>
  ),
  diff: (
    <>
      <path d="M12 3v18M5 8h6M5 16h6M13 12h6" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  download: <path d="M12 4v11m-5-5 5 5 5-5M5 19.5h14" />,
  expand: <path d="M14 4h6v6m0-6-7 7M10 20H4v-6m0 6 7-7" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  "external-link": (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
      <path d="M13.5 3v5.5H19" />
    </>
  ),
  fit: (
    <>
      <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1.2" />
    </>
  ),
  folder: (
    <path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.6L9.6 5H5a2 2 0 0 0-2 2.5Z" />
  ),
  grip: (
    <>
      <circle cx="9" cy="6" r="0.9" />
      <circle cx="15" cy="6" r="0.9" />
      <circle cx="9" cy="12" r="0.9" />
      <circle cx="15" cy="12" r="0.9" />
      <circle cx="9" cy="18" r="0.9" />
      <circle cx="15" cy="18" r="0.9" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a13.4 13.4 0 0 1 0 18M12 3a13.4 13.4 0 0 0 0 18" />
    </>
  ),
  hand: (
    <>
      <path d="M7 14.2V8a1.5 1.5 0 0 1 3 0v4" />
      <path d="M10 11.5V5.5a1.5 1.5 0 0 1 3 0v6" />
      <path d="M13 11.5V6.5a1.5 1.5 0 0 1 3 0v5" />
      <path d="M16 11.5V9a1.5 1.5 0 0 1 3 0v5.5a6.5 6.5 0 0 1-6.5 6.5h-1.3a6 6 0 0 1-4.6-2.2l-3-3.8a1.5 1.5 0 0 1 2.2-2L7 14.2" />
    </>
  ),
  "help-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.3 9.3a2.8 2.8 0 0 1 5.4.9c0 1.9-2.7 2.2-2.7 3.6M12 16.8v.2" />
    </>
  ),
  home: (
    <>
      <path d="m4 11 8-7 8 7v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Z" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M5 9h.01M9 9h.01M13 9h.01M17 9h.01M5 12h.01M9 12h.01M13 12h.01M17 12h.01M7 15h10" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4.2" />
      <path d="m11 12 9-9m-3.5 3.5L20 10m-5-2.5L17.5 10" />
    </>
  ),
  laptop: (
    <>
      <rect x="4.5" y="5" width="15" height="10" rx="1.8" />
      <path d="M2.5 18.5h19" />
    </>
  ),
  list: (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
    </>
  ),
  "log-out": (
    <>
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="M16 17.5 21 12l-5-5.5M21 12H9.5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  message: (
    <path d="M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 21l1.6-4.8A8.5 8.5 0 1 1 21 12Z" />
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="0.9" />
      <circle cx="12" cy="12" r="0.9" />
      <circle cx="18.5" cy="12" r="0.9" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M15 4v16" />
    </>
  ),
  phone: (
    <>
      <rect x="6.6" y="2.6" width="10.8" height="18.8" rx="2.8" />
      <path d="M10.8 5.4h2.4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.3-5.4-6.3-10.7a6.3 6.3 0 0 1 12.6 0C18.3 15.6 12 21 12 21Z" />
      <circle cx="12" cy="10.3" r="2.2" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.5 19.5h4l10-10a2.5 2.5 0 0 0-3.5-3.5l-10 10v3.5Z" />
      <path d="m13.8 7.2 3 3" />
    </>
  ),
  "paper-plane": <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5 21 3Z" />,
  paperclip: (
    <path d="m20 11-7.8 7.8a5 5 0 0 1-7-7L13 4a3.4 3.4 0 0 1 4.8 4.8l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4L15 6.8" />
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  queue: (
    <>
      <path d="M4 6.5h16M4 12h10M4 17.5h6" />
      <path d="m17 14.5 3 3-3 3M13.5 17.5H20" />
    </>
  ),
  // Android's recent apps: the square its navigation bar draws.
  recents: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  reply: (
    <>
      <path d="m9 14-5-5 5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5V20" />
    </>
  ),
  puzzle: (
    <path d="M10 3.5a1.8 1.8 0 0 1 3.5.6V5a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-.9a1.8 1.8 0 1 0-.6 3.5H17.5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-.9a1.8 1.8 0 1 0-3.5-.6V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h.9a1.8 1.8 0 1 0 .6-3.5H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 0 1-1v-.9c0-.2 0-.4.1-.6Z" />
  ),
  repeat: (
    <>
      <path d="m17 3 3.5 3.5L17 10" />
      <path d="M3.5 11.5v-1a4 4 0 0 1 4-4h13" />
      <path d="m7 21-3.5-3.5L7 14" />
      <path d="M20.5 12.5v1a4 4 0 0 1-4 4h-13" />
    </>
  ),
  reload: (
    <>
      <path d="M20 5v5h-5" />
      <path d="M4 12a8 8 0 0 1 14.5-4.6L20 10M4 12a8 8 0 0 0 14.6 4.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  send: <path d="M12 19V5m-7 7 7-7 7 7" />,
  server: (
    <>
      <rect x="3.2" y="4.2" width="17.6" height="6.2" rx="2" />
      <rect x="3.2" y="13.6" width="17.6" height="6.2" rx="2" />
      <path d="M6.6 7.3h.01M6.6 16.7h.01" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.5-2.4 1a7 7 0 0 0-2.4-1.4L13.7 2.6h-3.4l-.4 2.55a7 7 0 0 0-2.4 1.4l-2.4-1-2 3.5 2 1.55a7.2 7.2 0 0 0 0 2.8l-2 1.55 2 3.5 2.4-1a7 7 0 0 0 2.4 1.4l.4 2.55h3.4l.36-2.55a7 7 0 0 0 2.4-1.4l2.4 1 2-3.5-2-1.55c.1-.45.14-.92.14-1.4Z" />
    </>
  ),
  share: (
    <>
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="17.5" cy="5.5" r="2.6" />
      <circle cx="17.5" cy="18.5" r="2.6" />
      <path d="m8.4 10.7 6.8-3.9m-6.8 6.4 6.8 3.9" />
    </>
  ),
  shield: <path d="M12 3.2 18.8 6v5.2c0 4.4-2.9 7.7-6.8 9.6-3.9-1.9-6.8-5.2-6.8-9.6V6L12 3.2Z" />,
  sliders: (
    <>
      <path d="M4 7.5h9.5m5 0H20M4 16.5h1.5m5 0H20" />
      <circle cx="16" cy="7.5" r="2.5" />
      <circle cx="8" cy="16.5" r="2.5" />
    </>
  ),
  sparkles: (
    <path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9 12 3.5ZM19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z" />
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  terminal: <path d="m5 7 5 5-5 5m8 0h6" />,
  trash: (
    <>
      <path d="M4.5 6.5h15M9.5 6V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V6" />
      <path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
    </>
  ),
  undo: (
    <>
      <path d="M8.4 9.6h7.2a4.2 4.2 0 0 1 0 8.4h-4.8" />
      <path d="m11.4 6.6-3 3 3 3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
      <path d="M8.5 10.5v-3a3.5 3.5 0 0 1 6.8-1.2M12 14.5V17" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M5 20a7.2 7.2 0 0 1 14 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.6 18.6c.7-2.9 2.9-4.3 5.4-4.3s4.7 1.4 5.4 4.3" />
      <circle cx="16.3" cy="9.6" r="2.4" />
      <path d="M15.6 14.3c2.2 0 3.8 1.1 4.7 3.5" />
    </>
  ),
  workspace: (
    <>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.8" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="1.8" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  /** Present makes the icon a labelled image; absent keeps it decorative. */
  title?: string | undefined;
}

export function Icon({ className, name, title, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      className={className ? `icon ${className}` : "icon"}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {paths[name]}
    </svg>
  );
}
