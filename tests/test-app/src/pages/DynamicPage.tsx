import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Skeleton } from '../components/Skeleton'

const LazyStatsPanel = lazy(async () => {
    await new Promise((resolve) => setTimeout(resolve, 360))
    return {
        default: function StatsPanel(): JSX.Element {
            return (
                <div
                    id="lazy-stats-panel"
                    className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm"
                >
                    <p className="font-semibold text-emerald-800">
                        Pipeline recovered
                    </p>
                    <p className="mt-1 text-emerald-700">
                        Error rate dropped from 3.9% to 0.6% in the last hour.
                    </p>
                </div>
            )
        },
    }
})

export function DynamicPage(): JSX.Element {
    const [loading, setLoading] = useState(true)
    const [showReveal, setShowReveal] = useState(false)
    const [showDelayed, setShowDelayed] = useState(false)
    const [timeline, setTimeline] = useState<string[]>(['Queue initialized'])

    useEffect(() => {
        const handle = window.setTimeout(() => {
            setLoading(false)
        }, 550)
        return () => window.clearTimeout(handle)
    }, [])

    const timelineSummary = useMemo(() => timeline.join(' -> '), [timeline])

    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Dynamic Content and Transitions</h1>
                <p className="page-subtitle">
                    Simulates delayed hydration, lazy boundaries, and
                    transition-driven content updates.
                </p>
            </header>

            <section className="card space-y-4">
                <h2 className="card-title">Skeleton to Content</h2>
                {loading ? (
                    <Skeleton id="loading-skeleton" lines={4} />
                ) : (
                    <article
                        id="loaded-content"
                        className="rounded-xl border border-slate-200 p-4"
                    >
                        <h3 className="text-base font-semibold">
                            Realtime Incident Feed
                        </h3>
                        <p className="mt-2 text-sm text-slate-600">
                            Feed settled after upstream retries. No active
                            incidents remain.
                        </p>
                    </article>
                )}
            </section>

            <section className="card space-y-4">
                <h2 className="card-title">Animated Reveal</h2>
                <button
                    id="animate-panel-btn"
                    className="btn btn-primary"
                    onClick={() => setShowReveal(true)}
                >
                    Reveal Panel
                </button>

                <div
                    id="animated-panel"
                    className={`rounded-xl border border-slate-200 p-4 ${
                        showReveal
                            ? 'fade-slide fade-slide-enter-active'
                            : 'fade-slide fade-slide-enter'
                    }`}
                >
                    <p className="text-sm text-slate-700">
                        This panel transitions from hidden to visible for
                        animation-related snapshots.
                    </p>
                </div>
            </section>

            <section className="card space-y-4">
                <h2 className="card-title">Delayed Event Stream</h2>
                <div className="flex flex-wrap gap-2">
                    <button
                        id="queue-update-btn"
                        className="btn btn-secondary"
                        onClick={() => {
                            setTimeline((prev) => [...prev, 'Retry scheduled'])
                            window.setTimeout(() => {
                                setShowDelayed(true)
                                setTimeline((prev) => [
                                    ...prev,
                                    'Worker resumed',
                                ])
                            }, 600)
                        }}
                    >
                        Queue delayed update
                    </button>
                </div>

                {showDelayed ? (
                    <p
                        id="delayed-message"
                        className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800"
                    >
                        Delayed message arrived from polling endpoint.
                    </p>
                ) : (
                    <p
                        id="delayed-placeholder"
                        className="text-sm text-slate-500"
                    >
                        Waiting for delayed content...
                    </p>
                )}

                <p id="timeline-summary" className="text-xs text-slate-500">
                    {timelineSummary}
                </p>
            </section>

            <section className="card">
                <h2 className="card-title">Suspense Boundary</h2>
                <Suspense fallback={<Skeleton id="lazy-fallback" lines={2} />}>
                    <LazyStatsPanel />
                </Suspense>
            </section>
        </main>
    )
}
