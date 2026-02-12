import { useState } from 'react'
import { CustomCheckbox } from '../components/CustomCheckbox'
import { CustomDropdown } from '../components/CustomDropdown'

export function CustomWidgetsPage(): JSX.Element {
    const [widgetCount, setWidgetCount] = useState(0)
    const [searchTerm, setSearchTerm] = useState('')
    const [sliderValue, setSliderValue] = useState(30)

    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Custom Widgets</h1>
                <p className="page-subtitle">
                    Non-native controls and role-based widgets that mimic modern
                    design systems.
                </p>
            </header>

            <section className="grid gap-4 lg:grid-cols-2">
                <article className="card space-y-4">
                    <h2 className="card-title">Composite Controls</h2>
                    <CustomDropdown
                        id="custom-dropdown"
                        label="Workspace"
                        options={[
                            { value: 'alpha', label: 'Alpha Workspace' },
                            { value: 'beta', label: 'Beta Workspace' },
                            { value: 'gamma', label: 'Gamma Workspace' },
                        ]}
                    />

                    <CustomCheckbox
                        id="custom-checkbox"
                        label="Enable staged rollout"
                    />

                    <div
                        id="role-button-div"
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer rounded-xl border border-slate-300 px-3 py-2 text-sm"
                        onClick={() => setWidgetCount((prev) => prev + 1)}
                    >
                        Role button click count:{' '}
                        <span id="role-button-count">{widgetCount}</span>
                    </div>
                </article>

                <article className="card space-y-4">
                    <h2 className="card-title">Search Widget</h2>
                    <div
                        id="custom-search"
                        role="search"
                        className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2"
                    >
                        <svg
                            id="search-icon"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                        >
                            <circle
                                cx="11"
                                cy="11"
                                r="7"
                                stroke="currentColor"
                                strokeWidth="2"
                                fill="none"
                            />
                            <path
                                d="M20 20l-3.5-3.5"
                                stroke="currentColor"
                                strokeWidth="2"
                            />
                        </svg>
                        <input
                            id="custom-search-input"
                            aria-label="Search dashboards"
                            className="w-full border-0 text-sm outline-none"
                            placeholder="Search dashboards"
                            value={searchTerm}
                            onChange={(event) =>
                                setSearchTerm(event.target.value)
                            }
                        />
                    </div>

                    <div
                        id="editable-widget"
                        contentEditable
                        suppressContentEditableWarning
                        className="min-h-20 rounded-xl border border-slate-300 p-3 text-sm"
                    >
                        Edit custom notes directly in this widget.
                    </div>

                    <a
                        id="anchor-no-href"
                        className="cursor-pointer text-sm text-teal-700 underline"
                    >
                        Anchor without href
                    </a>

                    <label
                        htmlFor="range-slider"
                        className="block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500"
                    >
                        Priority slider
                    </label>
                    <input
                        id="range-slider"
                        type="range"
                        min={0}
                        max={100}
                        value={sliderValue}
                        onChange={(event) =>
                            setSliderValue(Number(event.target.value))
                        }
                    />
                    <p id="slider-output" className="text-sm text-slate-600">
                        Priority: {sliderValue}
                    </p>
                </article>
            </section>
        </main>
    )
}
