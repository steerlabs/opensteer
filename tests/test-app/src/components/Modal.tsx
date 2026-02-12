import { type PropsWithChildren, useEffect } from 'react'
import { createPortal } from 'react-dom'

interface ModalProps {
    id?: string
    open: boolean
    title: string
    onClose: () => void
}

export function Modal({
    id = 'global-modal',
    open,
    title,
    onClose,
    children,
}: PropsWithChildren<ModalProps>): JSX.Element | null {
    useEffect(() => {
        if (!open) return

        const onEsc = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose()
            }
        }

        window.addEventListener('keydown', onEsc)
        return () => window.removeEventListener('keydown', onEsc)
    }, [open, onClose])

    if (!open) return null

    const root = document.getElementById('modal-root') ?? document.body

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
            onClick={onClose}
            data-testid="modal-backdrop"
        >
            <div
                id={id}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-lg font-semibold">{title}</h3>
                    <button
                        id="modal-close-btn"
                        className="btn btn-secondary"
                        onClick={onClose}
                    >
                        Close
                    </button>
                </div>
                <div className="space-y-4 text-sm text-slate-700">
                    {children}
                </div>
            </div>
        </div>,
        root
    )
}
