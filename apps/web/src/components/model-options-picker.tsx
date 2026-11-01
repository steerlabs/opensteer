import type { HarnessModelDescriptor } from "@opensteer/protocol";
import {
  modelSettings,
  withSetting,
  type LadderSetting,
  type OptionValues,
} from "@opensteer/client/host";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { Icon } from "./icon.js";

export function ModelSettingsPanel({
  model,
  values,
  onChange,
  choice,
  onChoice,
}: {
  model: HarnessModelDescriptor;
  values: OptionValues;
  /** Settles once the change is applied or has failed and the values say so. */
  onChange: (values: OptionValues) => Promise<void> | void;
  choice: string | null;
  onChoice: (id: string | null) => void;
}) {
  // A change reads as made the moment it is made: a round trip on a slow link
  // must not snap a control back to where it was until the Host answers.
  const [pending, setPending] = useState<OptionValues | null>(null);
  const shown = pending ?? values;
  const change = (next: OptionValues) => {
    setPending(next);
    void Promise.resolve(onChange(next)).finally(() =>
      setPending((current) => (current === next ? null : current)),
    );
  };
  const settings = modelSettings(model, shown);
  const selected = settings.find((setting) => setting.id === choice && setting.kind === "choice");
  return (
    <div className="execution-menu__settings">
      {selected?.kind === "choice" ? (
        <>
          <button
            data-view-back
            type="button"
            className="execution-menu__back"
            onClick={() => onChoice(null)}
          >
            <Icon name="chevron-left" />
            {selected.label}
          </button>
          <div role="radiogroup" aria-label={selected.label}>
            {selected.choices.map((item) => (
              <button
                type="button"
                key={item.value}
                role="radio"
                aria-checked={selected.value === item.value}
                className="picker__row"
                onClick={() =>
                  change(withSetting(model, shown, { id: selected.id, value: item.value }))
                }
              >
                <span className="picker__label-stack">
                  <span className="picker__label">{item.label}</span>
                  {item.description ? (
                    <span className="picker__detail">{item.description}</span>
                  ) : null}
                </span>
                <span className="picker__check">
                  {selected.value === item.value ? <Icon name="check" /> : null}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        settings.map((setting) => (
          <div key={setting.id} className="execution-setting">
            {setting.kind === "ladder" ? (
              <div className="execution-setting__row">
                <span className="execution-setting__name">{setting.label}</span>
                {/* The engine choosing for itself is no step on the ladder,
                    so it sits beside the name as the way back to it. */}
                {setting.automatic ? (
                  <button
                    type="button"
                    className="execution-setting__automatic"
                    aria-pressed={setting.step === null}
                    title={setting.automatic.description ?? undefined}
                    onClick={() =>
                      change(
                        withSetting(model, shown, {
                          id: setting.id,
                          value: setting.automatic!.value,
                        }),
                      )
                    }
                  >
                    {setting.automatic.label}
                  </button>
                ) : null}
                <LadderSlider
                  // A different ladder is a different slider: no step under
                  // the pointer carries over to steps that are not there.
                  key={setting.steps.map((step) => step.value).join("\n")}
                  setting={setting}
                  onStep={(value) => change(withSetting(model, shown, { id: setting.id, value }))}
                />
              </div>
            ) : setting.kind === "switch" ? (
              <button
                type="button"
                role="switch"
                aria-label={setting.label}
                aria-checked={setting.on}
                aria-description={setting.description ?? undefined}
                title={setting.description ?? undefined}
                className="execution-setting__row execution-setting__switch"
                onClick={() =>
                  change(withSetting(model, shown, { id: setting.id, on: !setting.on }))
                }
              >
                <span className="execution-setting__name">{setting.label}</span>
                {setting.description ? (
                  <span className="execution-setting__hint">{setting.description}</span>
                ) : null}
                <span className="execution-switch" data-on={setting.on}>
                  <i />
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="execution-setting__row execution-setting__choice"
                data-choice={setting.id}
                onClick={() => onChoice(setting.id)}
              >
                <span className="execution-setting__name">{setting.label}</span>
                <span className="execution-setting__value">{setting.valueLabel}</span>
                <Icon name="chevron-right" />
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
/**
 * How hard the model reasons, as a stepped slider. A native range does the
 * work — pointer, touch, keyboard and assistive technology — invisibly over
 * the drawn rail; its thumb is as wide as the drawn one, so the value under
 * the pointer is the step under it.
 *
 * Dragging previews; the step is applied once, when the range settles (its
 * `change`), so sweeping across the rail sends one change, not one per step.
 */
function LadderSlider({
  setting,
  onStep,
}: {
  setting: LadderSetting;
  onStep: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const last = setting.steps.length - 1;
  const shown = preview ?? setting.step;
  // Hovering names a step before it is chosen, in the same place its name
  // will settle; holding the thumb names the step it is on.
  const named = preview ?? hover ?? setting.step;
  const settle = useEffectEvent((index: number) => {
    setPreview(null);
    const step = setting.steps[index];
    if (step && index !== setting.step) onStep(step.value);
  });
  useEffect(() => {
    const input = inputRef.current!;
    const onSettle = () => settle(Number(input.value));
    input.addEventListener("change", onSettle);
    return () => input.removeEventListener("change", onSettle);
  }, []);
  const hoverAt = (event: PointerEvent<HTMLInputElement>) => {
    if (event.pointerType === "touch" || event.buttons !== 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const thumb = parseFloat(
      getComputedStyle(event.currentTarget).getPropertyValue("--slider-thumb"),
    );
    const at = (event.clientX - box.left - thumb / 2) / (box.width - thumb);
    setHover(Math.max(0, Math.min(last, Math.round(at * last))));
  };
  // Every name the value can take, stacked in one cell: the widest sets the
  // width, so changing level never moves the slider.
  const names = [
    ...new Set([
      ...(setting.automatic ? [setting.automatic.label] : []),
      ...setting.steps.map((step) => step.label),
      setting.valueLabel,
    ]),
  ];
  const nameShown = named === null ? setting.valueLabel : setting.steps[named]!.label;
  return (
    <>
      <span
        className="slider"
        data-idle={shown === null ? "" : undefined}
        style={{ "--slider-at": (shown ?? 0) / last } as CSSProperties}
      >
        <span aria-hidden className="slider__fill" />
        {setting.steps.map((step, index) => (
          <span
            aria-hidden
            className="slider__notch"
            data-on={shown !== null && index < shown ? "" : undefined}
            data-hover={hover === index && preview === null && index !== shown ? "" : undefined}
            key={step.value}
            style={{ "--slider-at": index / last } as CSSProperties}
          />
        ))}
        <span aria-hidden className="slider__thumb" />
        <input
          ref={inputRef}
          type="range"
          aria-label={setting.label}
          aria-valuetext={shown === null ? setting.valueLabel : setting.steps[shown]!.label}
          min={0}
          max={last}
          step={1}
          value={shown ?? 0}
          onChange={(event) => setPreview(Number(event.target.value))}
          onPointerMove={hoverAt}
          onPointerLeave={() => setHover(null)}
        />
      </span>
      <span
        aria-hidden
        className="execution-setting__value slider__value"
        data-peek={named !== shown ? "" : undefined}
      >
        {names.map((name) => (
          <span data-shown={name === nameShown ? "" : undefined} key={name}>
            {name}
          </span>
        ))}
      </span>
    </>
  );
}
export function LevelMeter({ level, steps }: { level: number; steps: number }) {
  return (
    <svg aria-hidden className="level-meter" viewBox={`0 0 ${steps * 3.3} 12`}>
      {Array.from({ length: steps }, (_, index) => {
        const height = 4 + (8 * index) / Math.max(1, steps - 1);
        return (
          <rect
            key={index}
            className={index < level ? "level-meter__on" : undefined}
            fill="currentColor"
            width={2}
            height={height}
            x={index * 3.3}
            y={12 - height}
            rx={0.7}
          />
        );
      })}
    </svg>
  );
}
