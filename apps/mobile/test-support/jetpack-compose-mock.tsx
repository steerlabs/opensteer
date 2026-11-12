import { Fragment, useState, type ReactNode } from "react";

/**
 * `@expo/ui/jetpack-compose` drawn as DOM for happy-dom tests: a view whose
 * modifiers make it clickable is a button, its semantics description is its
 * accessible name, and a closed menu shows only its trigger.
 */
type Modifier =
  | { readonly kind: "click"; readonly handler: () => void }
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "other" };

interface ViewProps {
  readonly children?: ReactNode;
  readonly modifiers?: readonly Modifier[];
  readonly onClick?: () => void;
  readonly enabled?: boolean;
}

function view({ children, modifiers, onClick, enabled }: ViewProps): ReactNode {
  const click =
    modifiers?.find((modifier) => modifier.kind === "click")?.handler ?? onClick ?? null;
  const label = modifiers?.find((modifier) => modifier.kind === "label")?.label;
  return click === null ? (
    <div aria-label={label}>{children}</div>
  ) : (
    <button aria-label={label} disabled={enabled === false} onClick={click}>
      {children}
    </button>
  );
}
const slot = ({ children }: { readonly children?: ReactNode }) => <Fragment>{children}</Fragment>;

export const compose = {
  Box: view,
  Button: view,
  CircularProgressIndicator: () => null,
  Column: view,
  DropdownMenu: Object.assign(
    ({ children, expanded }: { children?: ReactNode; expanded?: boolean }) => (
      <div data-menu data-expanded={expanded === true}>
        {children}
      </div>
    ),
    { Trigger: slot, Items: slot },
  ),
  DropdownMenuItem: Object.assign(view, { Text: slot }),
  Host: view,
  IconButton: view,
  LazyColumn: view,
  ListItem: Object.assign(view, {
    HeadlineContent: slot,
    SupportingContent: slot,
    LeadingContent: slot,
    TrailingContent: slot,
    OverlineContent: slot,
  }),
  ModalBottomSheet: view,
  OutlinedTextField: Object.assign(
    ({
      value,
      onValueChange,
    }: {
      value?: { value: string };
      onValueChange?: (v: string) => void;
    }) => (
      <textarea
        value={value?.value}
        onChange={(event) => onValueChange?.(event.currentTarget.value)}
      />
    ),
    { Label: slot },
  ),
  RadioButton: () => null,
  RNHostView: slot,
  Row: view,
  SegmentedButton: Object.assign(view, { Label: slot }),
  SingleChoiceSegmentedButtonRow: view,
  Switch: ({
    value,
    onCheckedChange,
  }: {
    value: boolean;
    onCheckedChange?: (v: boolean) => void;
  }) => <input type="checkbox" checked={value} onChange={() => onCheckedChange?.(!value)} />,
  Text: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  TextButton: view,
  useNativeState: <T,>(initial: T) => {
    const [value, set] = useState(initial);
    return { value, set };
  },
};

const other = (): Modifier => ({ kind: "other" });
export const composeModifiers = {
  background: other,
  clickable: (handler: () => void): Modifier => ({ kind: "click", handler }),
  clip: other,
  fillMaxWidth: other,
  padding: other,
  selectable: (_selected: boolean, handler: () => void): Modifier => ({ kind: "click", handler }),
  semantics: ({ contentDescription }: { contentDescription?: string }): Modifier =>
    contentDescription === undefined
      ? { kind: "other" }
      : { kind: "label", label: contentDescription },
  Shapes: { Circle: {} },
  size: other,
  toggleable: (_value: boolean, handler: () => void): Modifier => ({ kind: "click", handler }),
};
