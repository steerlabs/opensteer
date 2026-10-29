/** DOM helpers shared by the connect page and the popup. No framework: two small pages. */

type Shape = ["path", string] | ["circle", number, number, number];

// Paths copied from apps/web/src/components/icon.tsx so the extension speaks
// the product's icon language.
const icons = {
  "alert-circle": [
    ["circle", 12, 12, 9],
    ["path", "M12 8v4.5M12 15.8v.2"],
  ],
  "external-link": [
    ["path", "M14 4h6v6M20 4l-9 9"],
    ["path", "M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5"],
  ],
  globe: [
    ["circle", 12, 12, 9],
    ["path", "M3 12h18M12 3a13.4 13.4 0 0 1 0 18M12 3a13.4 13.4 0 0 0 0 18"],
  ],
  reload: [
    ["path", "M20 5v5h-5"],
    ["path", "M4 12a8 8 0 0 1 14.5-4.6L20 10M4 12a8 8 0 0 0 14.6 4.5"],
  ],
  download: [["path", "M12 4v11m-5-5 5 5 5-5M5 20h14"]],
  "log-out": [
    ["path", "M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"],
    ["path", "M16 17.5 21 12l-5-5.5M21 12H9.5"],
  ],
} satisfies Record<string, Shape[]>;
export type IconName = keyof typeof icons;

const svgNs = "http://www.w3.org/2000/svg";

export function icon(name: IconName, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  for (const shape of icons[name] as Shape[]) {
    const element = document.createElementNS(svgNs, shape[0]);
    if (shape[0] === "path") element.setAttribute("d", shape[1]);
    if (shape[0] === "circle") {
      element.setAttribute("cx", String(shape[1]));
      element.setAttribute("cy", String(shape[2]));
      element.setAttribute("r", String(shape[3]));
    }
    svg.append(element);
  }
  return svg;
}

type Child = Node | string | null | false | undefined;

/** `h("p.note", {role: "status"}, "Text")` — a tag, optional classes, attributes and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  attributes: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split(".") as [K, ...string[]];
  const element = document.createElement(tag);
  if (classes.length) element.className = classes.join(" ");
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    element.append(child);
  }
  return element;
}

export function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

/** "2 h ago", "just now": coarse on purpose — the person needs recency, not a timestamp. */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function hostOf(origin: string): string {
  return new URL(origin).host;
}
