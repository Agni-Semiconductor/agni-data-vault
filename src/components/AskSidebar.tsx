import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AskConversation from '../pages/search/AskConversation'

/**
 * The assistant as a panel, not a destination.
 *
 * As its own tab it took you away from whatever you were looking at, and the answer arrived
 * somewhere you then had to leave. As a slide-over it is available from every page, and what it
 * produces is a URL.
 *
 * THE COMMITMENT: the answer is a URL. The agent already returns one, so nothing is re-derived
 * here -- the filter it proposes and one you build by hand are the same object, landing on the same
 * page, editable and shareable. An assistant whose output can only be consumed by itself has no
 * place in a system built on provenance.
 */
export default function AskSidebar() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  useEffect(() => {
    // Move focus into the panel when it opens and back to the opener when it closes, or keyboard
    // users tab from the header into a panel they cannot see the start of.
    if (open) panelRef.current?.focus()
    else openerRef.current?.focus({ preventScroll: true })
  }, [open])

  const openFilter = useCallback(
    (url: string) => {
      setOpen(false)
      navigate(url)
    },
    [navigate],
  )

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="rounded-md border border-border-subtle px-2 py-1 text-sm text-agni-ink hover:border-agni-orange hover:text-agni-orange"
      >
        Ask
      </button>
      {open ? (
        <>
          {/* The scrim is a sibling, not a parent: a click target that also contains the panel
              swallows clicks meant for the panel unless every one of them stops propagation. */}
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Ask the vault"
            tabIndex={-1}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border-subtle bg-surface-1 shadow-overlay focus:outline-none"
          >
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
              <h2 className="text-base">Ask the vault</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-md px-2 py-1 text-agni-slate hover:text-agni-orange"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <AskConversation onOpenFilter={openFilter} />
            </div>
          </div>
        </>
      ) : null}
    </>
  )
}
