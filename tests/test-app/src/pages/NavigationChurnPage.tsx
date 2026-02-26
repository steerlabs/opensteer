import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

function readStage(search: string): string {
    const params = new URLSearchParams(search)
    const stage = (params.get('stage') || '').trim()
    return stage.length > 0 ? stage : '1'
}

export function NavigationChurnPage(): JSX.Element {
    const location = useLocation()
    const stage = readStage(location.search)
    const shouldChurn = stage !== '2'

    useEffect(() => {
        if (!shouldChurn) return

        const timer = window.setTimeout(() => {
            window.location.replace('/navigation-churn?stage=2')
        }, 60)

        return () => {
            window.clearTimeout(timer)
        }
    }, [shouldChurn])

    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Navigation Context Churn</h1>
                <p className="page-subtitle">
                    Forces a follow-up main-frame navigation shortly after
                    initial load.
                </p>
            </header>

            <section className="card space-y-3">
                <p id="navigation-churn-stage" className="text-sm font-medium">
                    Stage {stage}
                </p>
                {stage === '2' ? (
                    <input
                        id="navigation-churn-input"
                        type="text"
                        placeholder="search"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                ) : (
                    <p
                        id="navigation-churn-transition"
                        className="text-sm text-slate-600"
                    >
                        Triggering second navigation...
                    </p>
                )}
            </section>
        </main>
    )
}
