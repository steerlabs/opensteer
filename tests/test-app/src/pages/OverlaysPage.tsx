import { useState } from 'react'
import { Modal } from '../components/Modal'
import { Toast } from '../components/Toast'

export function OverlaysPage(): JSX.Element {
    const [modalOpen, setModalOpen] = useState(false)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [toastOpen, setToastOpen] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const [cookieVisible, setCookieVisible] = useState(true)
    const [tooltipVisible, setTooltipVisible] = useState(false)

    return (
        <main className="page-shell space-y-6">
            <header>
                <h1 className="page-title">Overlays and Floating UI</h1>
                <p className="page-subtitle">
                    Exercises portal rendering, dismiss logic, hover-driven
                    content, and fixed overlays.
                </p>
            </header>

            <section className="card flex flex-wrap gap-3">
                <button
                    id="open-modal-btn"
                    className="btn btn-primary"
                    onClick={() => setModalOpen(true)}
                >
                    Open modal
                </button>
                <button
                    id="open-drawer-btn"
                    className="btn btn-secondary"
                    onClick={() => setDrawerOpen(true)}
                >
                    Open drawer
                </button>
                <button
                    id="show-toast-btn"
                    className="btn btn-secondary"
                    onClick={() => setToastOpen(true)}
                >
                    Show toast
                </button>
                <div className="relative">
                    <button
                        id="dropdown-trigger"
                        className="btn btn-secondary"
                        onClick={() => setMenuOpen((prev) => !prev)}
                    >
                        Toggle menu
                    </button>
                    {menuOpen ? (
                        <div
                            id="dropdown-menu"
                            role="menu"
                            className="absolute left-0 top-11 z-30 w-44 rounded-xl border border-slate-200 bg-white p-2 shadow-xl"
                        >
                            <button
                                id="menu-edit"
                                role="menuitem"
                                className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100"
                            >
                                Edit profile
                            </button>
                            <button
                                id="menu-archive"
                                role="menuitem"
                                className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100"
                            >
                                Archive project
                            </button>
                            <button
                                id="menu-share"
                                role="menuitem"
                                className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100"
                            >
                                Share dashboard
                            </button>
                        </div>
                    ) : null}
                </div>

                <div className="relative inline-block">
                    <button
                        id="tooltip-target"
                        className="btn btn-secondary"
                        onMouseEnter={() => setTooltipVisible(true)}
                        onMouseLeave={() => setTooltipVisible(false)}
                    >
                        Hover for tooltip
                    </button>
                    {tooltipVisible ? (
                        <div
                            id="hover-tooltip"
                            role="tooltip"
                            className="absolute left-1/2 top-11 z-20 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-2 text-xs text-white"
                        >
                            Runs nightly at 02:00 UTC
                        </div>
                    ) : null}
                </div>
            </section>

            <section className="card">
                <h2 className="card-title">Content Behind Overlays</h2>
                <p className="text-sm text-slate-600">
                    This button should still exist in DOM when overlays are
                    open.
                </p>
                <button id="underlay-action" className="btn btn-secondary mt-3">
                    Background action
                </button>
            </section>

            {drawerOpen ? (
                <aside
                    id="settings-drawer"
                    className="fixed right-0 top-0 z-40 h-full w-[320px] border-l border-slate-200 bg-white p-5 shadow-2xl"
                >
                    <h2 className="card-title">Settings Drawer</h2>
                    <div className="space-y-3 text-sm text-slate-600">
                        <p>High-signal notifications are enabled.</p>
                        <label className="inline-flex items-center gap-2">
                            <input
                                id="drawer-toggle"
                                type="checkbox"
                                defaultChecked
                            />
                            Push alerts
                        </label>
                    </div>
                    <button
                        id="close-drawer-btn"
                        className="btn btn-secondary mt-4"
                        onClick={() => setDrawerOpen(false)}
                    >
                        Close drawer
                    </button>
                </aside>
            ) : null}

            <Modal
                id="portal-modal"
                open={modalOpen}
                title="Release Checklist"
                onClose={() => setModalOpen(false)}
            >
                <p>
                    Review QA notes, confirm analytics, and publish rollout
                    summary.
                </p>
                <div className="flex gap-2">
                    <button
                        id="modal-confirm-btn"
                        className="btn btn-primary"
                        onClick={() => setModalOpen(false)}
                    >
                        Confirm
                    </button>
                    <button
                        id="modal-cancel-btn"
                        className="btn btn-secondary"
                        onClick={() => setModalOpen(false)}
                    >
                        Cancel
                    </button>
                </div>
            </Modal>

            <Toast
                open={toastOpen}
                message="Draft saved successfully"
                onClose={() => setToastOpen(false)}
            />

            {cookieVisible ? (
                <div
                    id="cookie-banner"
                    className="fixed bottom-4 left-1/2 z-30 flex w-[min(94vw,720px)] -translate-x-1/2 items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
                >
                    <p>
                        We use cookies for performance analytics and session
                        reliability.
                    </p>
                    <div className="flex gap-2">
                        <button
                            id="accept-cookies-btn"
                            className="btn btn-primary"
                            onClick={() => setCookieVisible(false)}
                        >
                            Accept
                        </button>
                        <button
                            id="reject-cookies-btn"
                            className="btn btn-secondary"
                            onClick={() => setCookieVisible(false)}
                        >
                            Reject
                        </button>
                    </div>
                </div>
            ) : null}
        </main>
    )
}
