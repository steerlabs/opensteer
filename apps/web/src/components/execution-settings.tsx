import { useLayoutEffect, useRef } from "react";
import type { ModelSelection, ThreadAccessMode } from "@opensteer/core";
import { accessModeOptions, accessModeUnavailableReason } from "@opensteer/client/host";
import type { HarnessModelDescriptor } from "@opensteer/protocol";
import { accessModeGlyph, AccessModePanel, type AccessModeEngine } from "./access-mode-control.js";
import { Icon } from "./icon.js";
import { ModelOptionPanel, OptionGlyph, optionValueLabel } from "./model-options-picker.js";

/** The conversation's access mode, and how a change to it is applied. */
export interface ExecutionAccess {
  /** Null while no engine is chosen: nothing is ruled out yet. */
  readonly engine: AccessModeEngine | null;
  readonly mode: ThreadAccessMode;
  readonly onApply: (mode: ThreadAccessMode) => Promise<void> | void;
}

/**
 * What the choice in force can still be set to, beside which model runs it:
 * the model's own options (reasoning, speed and the like) and the access mode.
 */
export interface ExecutionSettings {
  readonly access: ExecutionAccess | null;
  /** The choice the settings belong to, "Codex · GPT-5.6-Sol"; null while nothing runs. */
  readonly current: string | null;
  readonly options: {
    readonly model: HarnessModelDescriptor;
    readonly onChange: (options: ModelSelection["options"]) => void;
    readonly values: ModelSelection["options"];
  } | null;
}

/** One setting the strip opens: an option of the model, by id, or the access mode. */
export type SettingKey = "access" | `option:${string}`;

/**
 * The settings of the choice in force, at the foot of the execution menu: one
 * row each, saying what it is set to. A choice among values opens its list in
 * the menu's place; a switch flips where it stands.
 */
export function SettingsStrip({
  onOpen,
  settings,
}: {
  readonly onOpen: (key: SettingKey) => void;
  readonly settings: ExecutionSettings;
}) {
  const { access, current, options } = settings;
  const refusal = access?.engine ? accessModeUnavailableReason(access.mode, access.engine) : null;
  // Named for the choice in force, so a browsed engine's models above never
  // read as what these settings change.
  const heading = current ? `Current · ${current}` : "Settings";
  return (
    <div aria-label={heading} className="engine-picker__settings" role="group">
      <span className="engine-picker__settings-heading">{heading}</span>
      {options?.model.options.map((option) => {
        const value = optionValueLabel(options.model, option, options.values);
        if (option.type !== "select") {
          const on = value === "On";
          return (
            <button
              aria-checked={on}
              className="setting-row"
              key={option.id}
              onClick={() => options.onChange({ ...options.values, [option.id]: !on })}
              role="switch"
              type="button"
            >
              <span className="setting-row__glyph">
                <OptionGlyph model={options.model} option={option} values={options.values} />
              </span>
              <span className="setting-row__name">{option.label}</span>
              <span className="setting-row__value">{value}</span>
            </button>
          );
        }
        return (
          <button
            aria-label={`${option.label}: ${value}`}
            className="setting-row"
            data-setting={`option:${option.id}`}
            key={option.id}
            onClick={() => onOpen(`option:${option.id}`)}
            type="button"
          >
            <span className="setting-row__glyph">
              <OptionGlyph model={options.model} option={option} values={options.values} />
            </span>
            <span className="setting-row__name">{option.label}</span>
            <span className="setting-row__value">{value}</span>
            <Icon className="setting-row__more" name="chevron-right" />
          </button>
        );
      })}
      {access ? (
        <button
          aria-label={`Access: ${accessLabel(access.mode)}${refusal ? ` (${refusal})` : ""}`}
          className={refusal ? "setting-row is-unavailable" : "setting-row"}
          data-setting="access"
          onClick={() => onOpen("access")}
          title={refusal ?? undefined}
          type="button"
        >
          <span className="setting-row__glyph">
            <Icon name={accessModeGlyph[access.mode]} />
          </span>
          <span className="setting-row__name">Access</span>
          <span className="setting-row__value">{accessLabel(access.mode)}</span>
          <Icon className="setting-row__more" name="chevron-right" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * One setting's choices, in the menu's place, with the way back above them.
 * Choosing applies through the same path as every other execution choice;
 * the menu then closes, as it does when a model is picked.
 */
export function SettingDetail({
  onBack,
  onDone,
  setting,
  settings,
}: {
  readonly onBack: () => void;
  readonly onDone: () => void;
  readonly setting: SettingKey;
  readonly settings: ExecutionSettings;
}) {
  const { access, options } = settings;
  const option =
    setting === "access"
      ? null
      : (options?.model.options.find((candidate) => `option:${candidate.id}` === setting) ?? null);
  const title = setting === "access" ? "Access" : (option?.label ?? "Settings");
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The menu was already open, so nothing else moves the keyboard here: it
  // lands on the value in force, or on the way back when none is.
  useLayoutEffect(() => {
    const root = rootRef.current;
    (
      root?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
      root?.querySelector<HTMLElement>(".engine-picker__back")
    )?.focus();
  }, []);
  return (
    <div className="engine-picker__detail" ref={rootRef}>
      <button
        aria-label={`Back to models · ${title}`}
        className="engine-picker__back"
        onClick={onBack}
        type="button"
      >
        <Icon name="chevron-left" />
        {title}
      </button>
      <div aria-label={title} className="picker__list engine-picker__pane" role="menu">
        {setting === "access" && access ? (
          <AccessModePanel
            engine={access.engine}
            mode={access.mode}
            onSelect={(mode) => {
              onDone();
              if (mode !== access.mode) void access.onApply(mode);
            }}
          />
        ) : option && options ? (
          <>
            {optionValueLabel(options.model, option, options.values) === "Saved configuration" ? (
              <p className="picker__empty">
                Choose a value to replace the saved one this engine no longer offers.
              </p>
            ) : null}
            <ModelOptionPanel
              model={options.model}
              onChange={(next, closeAfter) => {
                if (closeAfter) onDone();
                options.onChange(next);
              }}
              option={option}
              values={options.values}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function accessLabel(mode: ThreadAccessMode): string {
  return accessModeOptions.find((option) => option.mode === mode)?.label ?? mode;
}
