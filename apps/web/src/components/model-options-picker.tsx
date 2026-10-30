import type { HarnessModelDescriptor } from "@opensteer/protocol";
import { modelSettings, withSetting, type OptionValues } from "@opensteer/client/host";

export function ModelSettingsPanel({
  model,
  values,
  onChange,
  choice,
  onChoice,
}: {
  model: HarnessModelDescriptor;
  values: OptionValues;
  onChange: (values: OptionValues) => void;
  choice: string | null;
  onChoice: (id: string | null) => void;
}) {
  const settings = modelSettings(model, values);
  const selected = settings.find((setting) => setting.id === choice && setting.kind === "choice");
  return (
    <div className="execution-menu__settings">
      {selected?.kind === "choice" ? (
        <>
          <button
            data-view-back
            type="button"
            className="picker__row"
            onClick={() => onChoice(null)}
          >
            ‹ {selected.label}
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
                  onChange(withSetting(model, values, { id: selected.id, value: item.value }))
                }
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        settings.map((setting) => (
          <div key={setting.id} className="execution-setting">
            {setting.kind === "ladder" ? (
              <>
                <div className="execution-setting__label">
                  <span>{setting.label}</span>
                  <span>{setting.valueLabel}</span>
                </div>
                <input
                  type="range"
                  onKeyDown={(event) => event.stopPropagation()}
                  aria-label={setting.label}
                  aria-valuetext={setting.valueLabel}
                  min={0}
                  max={setting.steps.length - 1}
                  step={1}
                  value={setting.step ?? 0}
                  onChange={(event) => {
                    const step = setting.steps[Number(event.target.value)];
                    if (step)
                      onChange(withSetting(model, values, { id: setting.id, value: step.value }));
                  }}
                />
                <div className="execution-setting__ends">
                  <span>Quicker</span>
                  {setting.automatic ? (
                    <button
                      type="button"
                      aria-pressed={
                        setting.step === null && setting.valueLabel === setting.automatic.label
                      }
                      onClick={() =>
                        onChange(
                          withSetting(model, values, {
                            id: setting.id,
                            value: setting.automatic!.value,
                          }),
                        )
                      }
                    >
                      {setting.automatic.label}
                    </button>
                  ) : null}
                  <span>Deeper</span>
                </div>
              </>
            ) : setting.kind === "switch" ? (
              <>
                <button
                  type="button"
                  role="switch"
                  aria-label={setting.label}
                  aria-checked={setting.on}
                  className="execution-setting__switch"
                  onClick={() =>
                    onChange(withSetting(model, values, { id: setting.id, on: !setting.on }))
                  }
                >
                  <span>{setting.label}</span>
                  <span className="execution-switch" data-on={setting.on}>
                    <i />
                  </span>
                </button>
                {setting.description ? (
                  <p className="picker__detail">{setting.description}</p>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                className="picker__row"
                data-choice={setting.id}
                onClick={() => onChoice(setting.id)}
              >
                {setting.label}
                <span className="picker__state">{setting.valueLabel} ›</span>
              </button>
            )}
          </div>
        ))
      )}
    </div>
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
