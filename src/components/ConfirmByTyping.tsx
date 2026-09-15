import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from './ui'

/**
 * A destructive confirmation that cannot be cleared by reflex.
 *
 * ONE implementation, used by both the measurement and the sample pages. Two copies of this dialog
 * would drift -- that is not a hypothetical in this codebase, where the browser and the server each
 * grew their own filename cleaner and produced different storage paths for the same file. The
 * gating rule below is the whole point of the component, and it should exist in exactly one place.
 *
 * THE RULE: the confirm button is enabled only on an EXACT match. No trim, no case folding. A
 * trailing space must not pass, because the failure being prevented is muscle memory -- typing
 * something plausible and hitting Enter -- and every accommodation makes the barrier easier to
 * clear without reading it.
 */
export default function ConfirmByTyping({
  open,
  onClose,
  title,
  phrase,
  description,
  confirmLabel,
  inputId,
  inputLabel,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** The exact string the operator must type. Shown to them; never inferred. */
  phrase: string
  /** What will be destroyed, stated concretely -- counts, not adjectives. */
  description: ReactNode
  confirmLabel: string
  inputId: string
  inputLabel: string
  onConfirm: () => void | Promise<void>
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  // Clear on close. A dialog that reopens already satisfied is a one-click delete wearing the
  // costume of a two-step one.
  useEffect(() => {
    if (!open) {
      setTyped('')
      setBusy(false)
    }
  }, [open])

  const matches = typed === phrase

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p>{description}</p>
        <label className="block text-sm font-medium text-agni-ink" htmlFor={inputId}>
          Type <code className="font-mono">{phrase}</code> to confirm
        </label>
        <input
          id={inputId}
          aria-label={inputLabel}
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-md border border-border-subtle bg-surface-1 px-3 py-2 text-sm outline-none focus:border-agni-orange"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            // busy is part of the gate: without it a double click fires the mutation twice, and
            // the second one 404s against something already gone.
            disabled={!matches || busy}
            onClick={async () => {
              if (!matches || busy) return
              setBusy(true)
              try {
                await onConfirm()
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
