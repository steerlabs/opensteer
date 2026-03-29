export const OPENSTEER_INTERACTIVE_ATTR = "data-opensteer-interactive";
export const OPENSTEER_HIDDEN_ATTR = "data-opensteer-hidden";
export const OPENSTEER_SCROLLABLE_ATTR = "data-opensteer-scrollable";

export const OPENSTEER_NODE_ID_ATTR = "data-os-node-id";
export const OPENSTEER_SPARSE_COUNTER_ATTR = "data-os-c";
export const OPENSTEER_BOUNDARY_ATTR = "data-os-boundary";
export const OPENSTEER_UNAVAILABLE_ATTR = "data-os-unavailable";
export const OPENSTEER_IFRAME_BOUNDARY_TAG = "os-iframe-root";
export const OPENSTEER_SHADOW_BOUNDARY_TAG = "os-shadow-root";

export const NATIVE_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
]);

export const INTERACTIVE_ROLE_TOKENS: readonly string[] = [
  "button",
  "link",
  "menuitem",
  "option",
  "radio",
  "checkbox",
  "tab",
  "textbox",
  "combobox",
  "slider",
  "spinbutton",
  "search",
  "searchbox",
];

export const INTERACTIVE_ROLE_SET: ReadonlySet<string> = new Set(INTERACTIVE_ROLE_TOKENS);

export const INTERACTIVE_SELECTOR_PARTS: readonly string[] = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  "[onclick]",
  "[onmousedown]",
  "[onmouseup]",
] as const;

export const INTERACTIVE_SELECTOR = INTERACTIVE_SELECTOR_PARTS.join(",");

export const NON_NEGATIVE_TAB_INDEX_MIN = 0;

export const ROOT_TAGS = new Set(["html", "body"]);

export const BOUNDARY_TAGS = new Set([
  OPENSTEER_IFRAME_BOUNDARY_TAG,
  OPENSTEER_SHADOW_BOUNDARY_TAG,
]);

export function isBoundaryTag(tag: string): boolean {
  return BOUNDARY_TAGS.has(tag);
}

export function hasNonNegativeTabIndex(value: string | null | undefined): boolean {
  if (value == null) {
    return false;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= NON_NEGATIVE_TAB_INDEX_MIN;
}

export function isVoidHtmlTag(tag: string): boolean {
  return VOID_TAGS.has(tag);
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
