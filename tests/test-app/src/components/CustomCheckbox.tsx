import { useState } from 'react'

interface CustomCheckboxProps {
    id: string
    label: string
    defaultChecked?: boolean
}

export function CustomCheckbox({
    id,
    label,
    defaultChecked = false,
}: CustomCheckboxProps): JSX.Element {
    const [checked, setChecked] = useState(defaultChecked)

    return (
        <label
            htmlFor={id}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-300 bg-white px-3 py-2"
        >
            <input
                id={id}
                type="checkbox"
                className="sr-only-input"
                checked={checked}
                onChange={() => setChecked((prev) => !prev)}
            />
            <span
                id={`${id}-visual`}
                aria-hidden="true"
                className={`inline-flex h-5 w-5 items-center justify-center rounded-md border text-xs transition ${
                    checked
                        ? 'border-teal-700 bg-teal-700 text-white'
                        : 'border-slate-300 bg-white text-transparent'
                }`}
            >
                ✓
            </span>
            <span id={`${id}-label`} className="text-sm text-slate-700">
                {label}
            </span>
        </label>
    )
}
