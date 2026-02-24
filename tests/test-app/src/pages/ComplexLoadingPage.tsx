import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'

const PLACEHOLDER_IMAGE =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

function readQuery(search: string): string {
    const params = new URLSearchParams(search)
    return (params.get('q') || '').trim()
}

const frameSrcDoc = `<!doctype html>
<html lang="en">
  <body style="font-family:sans-serif;padding:8px;">
    <p id="frame-status">frame-loading</p>
    <script>
      window.setTimeout(() => {
        const status = document.querySelector('#frame-status');
        if (status) status.textContent = 'frame-ready';
      }, 180);
    </script>
  </body>
</html>`

export function ComplexLoadingPage(): JSX.Element {
    const location = useLocation()
    const query = useMemo(() => readQuery(location.search), [location.search])
    const isResultsRoute = location.pathname === '/complex-loading/results'
    const shouldLoadResults = isResultsRoute && query.length > 0

    const [status, setStatus] = useState<'idle' | 'loading' | 'ready'>(
        shouldLoadResults ? 'loading' : 'idle'
    )
    const [summary, setSummary] = useState('')
    const [heroLoaded, setHeroLoaded] = useState(!shouldLoadResults)

    useEffect(() => {
        if (!shouldLoadResults) {
            setStatus('idle')
            setSummary('')
            setHeroLoaded(true)
            return
        }

        setStatus('loading')
        setSummary('')
        setHeroLoaded(false)

        let polls = 0

        const indicator = document.getElementById('complex-loading-indicator')
        const animation = indicator?.animate(
            [{ opacity: 0.35 }, { opacity: 1 }],
            {
                duration: 320,
                fill: 'forwards',
                easing: 'ease-out',
            }
        )

        const readyTimer = window.setTimeout(() => {
            setStatus('ready')
            setSummary(`results-for-${query}`)
        }, 260)

        const pollTimer = window.setInterval(() => {
            polls += 1
            void fetch(`/__test__/wait/poll?i=${polls}`).catch(() => {})
            if (polls >= 50) {
                window.clearInterval(pollTimer)
            }
        }, 110)

        void fetch(
            `/__test__/wait/slow-search?q=${encodeURIComponent(query)}`
        ).catch(() => {})

        return () => {
            animation?.cancel()
            window.clearTimeout(readyTimer)
            window.clearInterval(pollTimer)
        }
    }, [query, shouldLoadResults])

    const heroImageSrc = shouldLoadResults
        ? `/__test__/wait/image?q=${encodeURIComponent(query)}`
        : PLACEHOLDER_IMAGE

    return (
        <main className="page-shell space-y-6">
            <header className="space-y-2">
                <h1 className="page-title">Complex Loading Flows</h1>
                <p className="page-subtitle">
                    Simulates noisy post-submit behavior similar to retail and
                    logistics pages.
                </p>
            </header>

            <section className="card space-y-3">
                <form
                    id="complex-search-form"
                    action="/complex-loading/results"
                    method="get"
                    className="flex flex-col gap-3 sm:flex-row"
                >
                    <input
                        id="complex-search-box"
                        name="q"
                        defaultValue={query}
                        placeholder="Search catalog"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <button
                        id="complex-search-submit"
                        type="submit"
                        className="btn"
                    >
                        Search
                    </button>
                </form>
            </section>

            <section id="complex-results-panel" className="card space-y-3">
                <p id="complex-search-status" className="text-sm font-medium">
                    {status}
                </p>
                <p id="complex-search-summary" className="text-sm text-slate-600">
                    {summary || 'no-results-yet'}
                </p>
                <div
                    id="complex-loading-indicator"
                    className="h-2 w-56 rounded bg-slate-300"
                />
                <img
                    id="complex-hero-image"
                    src={heroImageSrc}
                    alt="Result preview"
                    className="h-10 w-10 rounded border border-slate-300 object-cover"
                    onLoad={() => setHeroLoaded(true)}
                />
                <p id="complex-image-state" className="text-xs text-slate-500">
                    image-loaded:{heroLoaded ? 'yes' : 'no'}
                </p>
                <iframe
                    id="complex-results-frame"
                    title="Complex result frame"
                    srcDoc={frameSrcDoc}
                    className="h-24 w-full rounded border border-slate-300"
                />
            </section>
        </main>
    )
}
