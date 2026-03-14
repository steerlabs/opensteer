import type { StepEvent } from "@opensteer/browser-core";

import type { AbpSelectPopupItem } from "./types.js";

type SelectChooserOption = NonNullable<
  Extract<StepEvent, { readonly kind: "chooser-opened" }>["options"]
>[number];

interface SelectChooserEventData {
  readonly multiple: boolean;
  readonly options?: readonly SelectChooserOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSelectPopupItem(value: unknown): AbpSelectPopupItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const index = readInteger(value.index);
  const type = readString(value.type);
  if (index === undefined || type === undefined) {
    return undefined;
  }

  const label = readString(value.label);
  const toolTip = readString(value.tool_tip);
  const enabled = readBoolean(value.enabled);
  const checked = readBoolean(value.checked);

  return {
    index,
    type,
    ...(label === undefined ? {} : { label }),
    ...(toolTip === undefined ? {} : { tool_tip: toolTip }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(checked === undefined ? {} : { checked }),
  };
}

function isSelectableSelectPopupItem(type: string): boolean {
  return type === "option" || type === "checkable_option";
}

export function buildSelectChooserOptions(
  items: unknown,
  selectedIndex?: number,
): readonly SelectChooserOption[] | undefined {
  if (!Array.isArray(items)) {
    return undefined;
  }

  const options = items.flatMap((value) => {
    const item = parseSelectPopupItem(value);
    if (item === undefined || !isSelectableSelectPopupItem(item.type)) {
      return [];
    }

    const label = item.label ?? item.tool_tip ?? "";
    return [
      {
        index: item.index,
        label,
        value: label,
        selected: (item.checked ?? false) || item.index === selectedIndex,
      } satisfies SelectChooserOption,
    ];
  });

  return options.length === 0 ? undefined : options;
}

export function normalizeSelectChooserEventData(
  data: Record<string, unknown>,
): SelectChooserEventData | undefined {
  const multiple = readBoolean(data.allow_multiple_selection);
  if (multiple === undefined) {
    return undefined;
  }

  const selectedIndex = readInteger(data.selected_index);
  const options = buildSelectChooserOptions(data.items, selectedIndex);
  return {
    multiple,
    ...(options === undefined ? {} : { options }),
  };
}
