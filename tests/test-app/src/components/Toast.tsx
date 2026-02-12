import { useEffect } from 'react'

interface ToastProps {
    open: boolean
    message: string
    durationMs?: number
    onClose: () => void
}

export function Toast({
    open,
    message,
    durationMs = 1800,
    onClose,
}: ToastProps): JSX.Element | null {
    useEffect(() => {
        if (!open) return
        const handle = window.setTimeout(onClose, durationMs)
        return () => window.clearTimeout(handle)
    }, [open, durationMs, onClose])

    if (!open) return null

    return (
        <div
            id="toast-notice"
            role="status"
            className="fixed right-5 top-20 z-40 rounded-xl border border-emerald-200 bg-emerald-600 px-4 py-3 text-sm font-medium text-white shadow-xl"
        >
            {message}
        </div>
    )
}
