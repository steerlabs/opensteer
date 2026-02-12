import { useMemo, useState } from 'react'

interface FormState {
    fullName: string
    email: string
    password: string
    age: string
    startDate: string
    volume: number
    bio: string
    plan: string
    channels: string[]
    marketing: boolean
    role: 'admin' | 'editor' | 'viewer'
}

const channelOptions = ['Email', 'SMS', 'Push', 'Webhooks']

export function FormsPage(): JSX.Element {
    const [state, setState] = useState<FormState>({
        fullName: '',
        email: '',
        password: '',
        age: '',
        startDate: '',
        volume: 35,
        bio: '',
        plan: 'starter',
        channels: ['Email'],
        marketing: false,
        role: 'editor',
    })

    const validation = useMemo(() => {
        const errors: string[] = []
        if (!state.fullName.trim()) errors.push('Name is required')
        if (!state.email.includes('@')) errors.push('Email must contain @')
        if (state.password.length < 8) errors.push('Password needs 8+ chars')
        return errors
    }, [state])

    return (
        <main className="page-shell">
            <h1 className="page-title">Forms Playground</h1>
            <p className="page-subtitle">
                Covers native form controls, contenteditable surfaces,
                validation, and disabled states.
            </p>

            <section className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                <form id="forms-page-form" className="card space-y-5">
                    <div className="field-grid">
                        <div className="field">
                            <label htmlFor="full-name">Full name</label>
                            <input
                                id="full-name"
                                name="fullName"
                                placeholder="Ada Lovelace"
                                value={state.fullName}
                                onChange={(event) =>
                                    setState((prev) => ({
                                        ...prev,
                                        fullName: event.target.value,
                                    }))
                                }
                            />
                        </div>

                        <div className="field">
                            <label htmlFor="email-input">Email address</label>
                            <input
                                id="email-input"
                                type="email"
                                name="email"
                                placeholder="ada@example.com"
                                value={state.email}
                                onChange={(event) =>
                                    setState((prev) => ({
                                        ...prev,
                                        email: event.target.value,
                                    }))
                                }
                            />
                        </div>

                        <div className="field">
                            <label htmlFor="password-input">Password</label>
                            <input
                                id="password-input"
                                type="password"
                                name="password"
                                value={state.password}
                                onChange={(event) =>
                                    setState((prev) => ({
                                        ...prev,
                                        password: event.target.value,
                                    }))
                                }
                            />
                        </div>

                        <div className="field">
                            <label htmlFor="age-input">Age</label>
                            <input
                                id="age-input"
                                type="number"
                                min={18}
                                max={100}
                                value={state.age}
                                onChange={(event) =>
                                    setState((prev) => ({
                                        ...prev,
                                        age: event.target.value,
                                    }))
                                }
                            />
                        </div>

                        <div className="field">
                            <label htmlFor="date-input">Start date</label>
                            <input
                                id="date-input"
                                type="date"
                                value={state.startDate}
                                onChange={(event) =>
                                    setState((prev) => ({
                                        ...prev,
                                        startDate: event.target.value,
                                    }))
                                }
                            />
                        </div>

                        <div className="field">
                            <label htmlFor="range-input">
                                Volume: {state.volume}%
                            </label>
                            <input
                                id="range-input"
                                type="range"
                                min={0}
                                max={100}
                                value={state.volume}
                                onChange={(event) =>
                                    setState((prev) => ({
                                        ...prev,
                                        volume: Number(event.target.value),
                                    }))
                                }
                            />
                        </div>

                        <div className="field md:col-span-2">
                            <label htmlFor="bio-input">Bio</label>
                            <textarea
                                id="bio-input"
                                rows={4}
                                placeholder="Tell us about your workflow"
                                value={state.bio}
                                onChange={(event) =>
                                    setState((prev) => ({
                                        ...prev,
                                        bio: event.target.value,
                                    }))
                                }
                            />
                        </div>
                    </div>

                    <div className="field-grid">
                        <div className="field">
                            <label htmlFor="plan-select">Plan</label>
                            <select
                                id="plan-select"
                                value={state.plan}
                                onChange={(event) =>
                                    setState((prev) => ({
                                        ...prev,
                                        plan: event.target.value,
                                    }))
                                }
                            >
                                <option value="starter">Starter</option>
                                <option value="pro">Pro</option>
                                <option value="enterprise">Enterprise</option>
                            </select>
                        </div>

                        <div className="field">
                            <label htmlFor="channels-select">
                                Notification channels
                            </label>
                            <select
                                id="channels-select"
                                multiple
                                size={4}
                                value={state.channels}
                                onChange={(event) => {
                                    const values = Array.from(
                                        event.target.selectedOptions
                                    ).map((option) => option.value)
                                    setState((prev) => ({
                                        ...prev,
                                        channels: values,
                                    }))
                                }}
                            >
                                {channelOptions.map((channel) => (
                                    <option key={channel} value={channel}>
                                        {channel}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <fieldset className="space-y-2 rounded-xl border border-slate-200 p-3">
                        <legend className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                            Role
                        </legend>
                        {(['admin', 'editor', 'viewer'] as const).map(
                            (role) => (
                                <label
                                    key={role}
                                    className="mr-4 inline-flex items-center gap-2 text-sm"
                                >
                                    <input
                                        id={`role-${role}`}
                                        name="role"
                                        type="radio"
                                        value={role}
                                        checked={state.role === role}
                                        onChange={() =>
                                            setState((prev) => ({
                                                ...prev,
                                                role,
                                            }))
                                        }
                                    />
                                    {role}
                                </label>
                            )
                        )}
                    </fieldset>

                    <label className="inline-flex items-center gap-2 text-sm">
                        <input
                            id="marketing-checkbox"
                            type="checkbox"
                            checked={state.marketing}
                            onChange={() =>
                                setState((prev) => ({
                                    ...prev,
                                    marketing: !prev.marketing,
                                }))
                            }
                        />
                        Receive weekly product insights
                    </label>

                    <div className="rounded-xl border border-slate-200 p-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                            Rich text note
                        </p>
                        <div
                            id="editable-note"
                            contentEditable
                            suppressContentEditableWarning
                            className="min-h-20 rounded-lg border border-slate-300 p-3 text-sm"
                        >
                            Editable content with{' '}
                            <strong>inline formatting</strong> for
                            contenteditable tests.
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-3">
                        <button
                            id="submit-btn"
                            type="button"
                            className="btn btn-primary"
                        >
                            Submit profile
                        </button>
                        <button
                            id="reset-btn"
                            type="reset"
                            className="btn btn-secondary"
                        >
                            Reset
                        </button>
                        <button
                            id="disabled-btn"
                            type="button"
                            className="btn btn-secondary"
                            disabled
                        >
                            Disabled action
                        </button>
                    </div>
                </form>

                <aside className="card space-y-4">
                    <h2 className="card-title">Live Validation</h2>
                    <ul
                        id="form-errors"
                        className="list-disc space-y-1 pl-5 text-sm text-rose-700"
                    >
                        {validation.length ? (
                            validation.map((item) => <li key={item}>{item}</li>)
                        ) : (
                            <li>All fields look valid.</li>
                        )}
                    </ul>

                    <div className="rounded-xl border border-slate-200 p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                            Preview
                        </p>
                        <p id="preview-name" className="mt-2 text-sm">
                            {state.fullName || 'No name yet'}
                        </p>
                        <p
                            id="preview-email"
                            className="text-sm text-slate-600"
                        >
                            {state.email || 'No email yet'}
                        </p>
                    </div>
                </aside>
            </section>
        </main>
    )
}
