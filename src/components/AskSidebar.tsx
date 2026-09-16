import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import AskConversation from '../pages/search/AskConversation'

/**
 * The assistant as a companion column, not an overlay.
 *
 * It began as a slide-OVER: a fixed panel above a dimmed scrim. That was wrong for how it is
 * actually used. The answer it produces is a filter you want to try against the list you were
 * already looking at, and an overlay makes that a sequence -- read, open, ask, dismiss, look --
 * when it should be a conversation with the page still in front of you. A scrim also says
 * "nothing else is available until you deal with me", which is false here.
 *
 * So the page COMPRESSES instead. The content column narrows, the panel takes the space beside it,
 * and everything on the left stays live: you can scroll the table, change a filter, click a row,
 * all while the panel is open.
 *
 * That also removes the modal machinery. No scrim, no aria-modal, no focus trap -- because focus is
 * no longer trapped, and pretending otherwise to a screen reader would be a lie about what the
 * page does.
 *
 * ALWAYS MOUNTED, never unmounted on close. Returning null when closed is why the old version
 * jolted: there was nothing in the row to animate FROM, so the panel arrived at full width and the
 * page snapped around it. Staying mounted is what lets the margin transition in index.css carry it
 * in and out, and it keeps a half-typed question alive across a close -- which, for a panel you
 * close to go look at something, is the behaviour you want anyway.
 */
export default function AskSidebar({ id, open, onClose }: { id?: string; open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    // Escape still closes it -- that is a convenience here rather than the only way out, since the
    // rest of the page remains clickable.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    // Move focus in on open so a keyboard user lands in the panel they just asked for. Focus is NOT
    // restored on close and NOT trapped while open: the page behind is a legitimate destination.
    if (open) panelRef.current?.focus()
  }, [open])

  const openFilter = useCallback(
    (url: string) => {
      // The panel stays OPEN. The whole point of compressing rather than covering is that you can
      // see the result arrive in the list beside you and keep refining.
      navigate(url)
    },
    [navigate],
  )

  return (
    <aside
      id={id}
      ref={panelRef}
      tabIndex={-1}
      aria-label="Ask the vault"
      // The closed panel is still in the document, parked off the right edge. `inert` is what keeps
      // that from being a trap: it takes the whole subtree out of the tab order, out of the
      // accessibility tree and out of hit testing at once. Without it a keyboard user tabs into a
      // form they cannot see -- worse than the jolt this change was made to fix.
      inert={!open}
      data-open={open ? 'true' : 'false'}
      // sticky + h-screen so the panel stays put while the page beside it scrolls; shrink-0 so the
      // content column gives up the width rather than the panel being squeezed to nothing. Width
      // and the closed margin come from .ask-panel, where one custom property holds both.
      className="ask-panel sticky top-0 flex h-screen shrink-0 flex-col border-l border-border-subtle bg-surface-1 focus:outline-none"
    >
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-4">
        <h2 className="text-base">Ask the vault</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the assistant"
          className="rounded-md px-2 py-1 text-agni-slate hover:text-agni-orange"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <AskConversation onOpenFilter={openFilter} />
      </div>
    </aside>
  )
}
