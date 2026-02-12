import { useMemo, useState } from 'react'

export function IframeContentPage(): JSX.Element {
    const params = new URLSearchParams(window.location.search)
    const kind = params.get('kind') ?? 'default'

    const [text, setText] = useState('')
    const [submitted, setSubmitted] = useState('')

    const frameLabel = useMemo(() => {
        if (kind === 'named') return 'Named Frame'
        if (kind === 'anonymous') return 'Anonymous Frame'
        return 'Generic Frame'
    }, [kind])

    return (
        <main className="min-h-screen bg-slate-50 p-3 font-sans text-slate-800">
            <h1
                id="iframe-content-title"
                className="text-sm font-semibold uppercase tracking-[0.08em] text-slate-500"
            >
                {frameLabel}
            </h1>

            <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-3">
                <label
                    htmlFor="iframe-input"
                    className="block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500"
                >
                    Frame input
                </label>
                <input
                    id="iframe-input"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
                />

                <button
                    id="iframe-submit-btn"
                    className="btn btn-primary"
                    onClick={() => setSubmitted(text.trim())}
                >
                    Save value
                </button>

                <p id="iframe-output" className="text-sm text-slate-700">
                    {submitted ? `Saved: ${submitted}` : 'No value saved'}
                </p>
            </div>
        </main>
    )
}
