import { useMemo, useState } from 'react'

export interface DropdownOption {
    value: string
    label: string
}

interface CustomDropdownProps {
    id: string
    label: string
    options: DropdownOption[]
    onChange?: (value: string) => void
}

export function CustomDropdown({
    id,
    label,
    options,
    onChange,
}: CustomDropdownProps): JSX.Element {
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState(options[0]?.value ?? '')

    const selectedLabel = useMemo(
        () =>
            options.find((option) => option.value === selected)?.label ??
            'Choose',
        [options, selected]
    )

    return (
        <div className="relative">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                {label}
            </label>
            <button
                id={id}
                type="button"
                role="combobox"
                aria-expanded={open}
                aria-controls={`${id}-list`}
                className="flex w-full items-center justify-between rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                onClick={() => setOpen((prev) => !prev)}
            >
                <span>{selectedLabel}</span>
                <span className="text-xs text-slate-500">v</span>
            </button>

            {open ? (
                <ul
                    id={`${id}-list`}
                    role="listbox"
                    className="absolute z-20 mt-2 w-full rounded-xl border border-slate-200 bg-white p-1 shadow-xl"
                >
                    {options.map((option) => (
                        <li key={option.value}>
                            <button
                                id={`${id}-option-${option.value}`}
                                role="option"
                                aria-selected={option.value === selected}
                                className="block w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100"
                                onClick={() => {
                                    setSelected(option.value)
                                    setOpen(false)
                                    onChange?.(option.value)
                                }}
                            >
                                {option.label}
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    )
}
