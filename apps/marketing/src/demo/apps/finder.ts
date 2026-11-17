import "./finder.css";

const glyph = (d: string, extra = ""): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}><path d="${d}"/></svg>`;

const SIDE = {
  airdrop: glyph("M8 9.2v4.8M4.6 11.4a4.8 4.8 0 1 1 6.8 0M3 13a7 7 0 1 1 10 0"),
  recents: glyph("M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 5v3.2l2 1.3"),
  apps: glyph("M8 2 3 13M8 2l5 11M4.6 9.5h6.8M2.5 13.5h3M10.5 13.5h3"),
  desktop: glyph("M2 3.5h12v8H2zM6 14h4M8 11.5V14"),
  documents: glyph("M4 1.8h5.2L12 4.6v9.6H4zM9 1.8v3h3M6 8h4M6 10.5h4"),
  downloads: glyph(
    "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 5.2v5.2M5.8 8.4 8 10.6l2.2-2.2",
  ),
  icloud: glyph("M4.6 12.5h7a2.9 2.9 0 0 0 .4-5.8 4.1 4.1 0 0 0-7.8-.8A3.3 3.3 0 0 0 4.6 12.5Z"),
  network: glyph(
    "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8S6.2 12.3 8 14",
  ),
};

const item = (icon: string, label: string): string =>
  `<div class="fd-item">${icon}<span>${label}</span></div>`;

/** A filing's Quick Look thumbnail at list size: a page of text. */
const PDF = `<svg class="fd-pdf" viewBox="0 0 14 16" aria-hidden="true"><path d="M1.5.5h8l3 3v12h-11z" fill="#fff" stroke="#b9b9be"/><path d="M9.5.5v3h3" fill="none" stroke="#b9b9be"/><path d="M3.5 5h4M3.5 7h7M3.5 8.6h7M3.5 10.2h7M3.5 11.8h5" stroke="#9a9aa0" stroke-width=".7"/></svg>`;

const file = (name: string, modified: string, size: string, fresh = false, hook = ""): string =>
  `<div class="fd-row${fresh ? " fd-row--new" : ""}"${hook ? ` data-h="${hook}"` : ""}><span class="fd-name">${PDF}${name}</span><span>${modified}</span><span>${size}</span><span>PDF Document</span></div>`;

/** The Finder, in list view: the case folder where the agent files what it downloads. */
export const finder = `<div class="win fd" data-win="finder" style="left:260px;top:150px;width:840px;height:420px">
  <aside class="fd-side">
    <span class="tl"><i></i><i></i><i></i></span>
    <h6>Favorites</h6>
    ${item(SIDE.airdrop, "AirDrop")}${item(SIDE.recents, "Recents")}${item(SIDE.apps, "Applications")}${item(SIDE.desktop, "Desktop")}${item(SIDE.documents, "Documents")}${item(SIDE.downloads, "Downloads")}
    <h6>Locations</h6>
    ${item(SIDE.icloud, "iCloud Drive")}${item(SIDE.network, "Network")}
  </aside>
  <div class="fd-main">
    <div class="fd-bar">
      <span class="fd-nav">${glyph("M10 3 5 8l5 5", ' stroke-width="1.6"')}${glyph("M6 3l5 5-5 5", ' class="is-off" stroke-width="1.6"')}</span>
      <b>Lumen v. Ardent</b>
      <span class="fd-tools">
        <span class="fd-view">${glyph("M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.8h11")}</span>
        ${glyph("M2.5 3h4.5v4.5H2.5zM9 3h4.5v4.5H9zM2.5 9.5h4.5V14H2.5zM9 9.5h4.5V14H9z")}
        ${glyph("M8 10V2.2M5.2 5 8 2.2 10.8 5M4.5 7.5h-1v6.5h9V7.5h-1")}
        ${glyph("M2.5 8.6V2.5h6.1l5 5-6.1 6.1zM5.5 5.5v.1")}
        <span class="fd-more">${glyph("M3.5 8h.1M8 8h.1M12.5 8h.1", ' stroke-width="2"')}</span>
        ${glyph("M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM10.6 10.6 14 14")}
      </span>
    </div>
    <div class="fd-head"><span>Name</span><span>Date Modified</span><span>Size</span><span>Kind</span></div>
    <div class="fd-rows">
      ${file("Dkt 01 Complaint.pdf", "Jun 22, 2026 at 3:18 PM", "2.4 MB")}
      ${file("Dkt 36 First Amended Complaint.pdf", "Oct 2, 2026 at 5:02 PM", "2.9 MB")}
      ${file("Dkt 38 Order on Stipulation.pdf", "Oct 16, 2026 at 11:40 AM", "164 KB")}
      ${file("Dkt 39 Clerk's Notice.pdf", "Oct 28, 2026 at 9:12 AM", "88 KB")}
      ${file("Dkt 41 Motion to Dismiss.pdf", "Today at 9:47 AM", "612 KB", true, "fd-first")}
      ${file("Dkt 42 Imbert Declaration.pdf", "Today at 9:47 AM", "301 KB", true)}
      ${file("Dkt 43 ADR Certification.pdf", "Today at 9:47 AM", "97 KB", true)}
    </div>
  </div>
</div>`;
