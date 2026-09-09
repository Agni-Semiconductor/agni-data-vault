import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from './Button'
export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!open) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; document.addEventListener('keydown', close); const first = dialog.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'); first?.focus(); return () => document.removeEventListener('keydown', close) }, [onClose, open])
  if (!open) return null
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div ref={dialog} role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-lg border border-border-subtle bg-white shadow-overlay"><header className="flex items-center justify-between border-b border-border-subtle px-5 py-4"><h2 className="text-lg font-semibold">{title}</h2><Button variant="ghost" size="sm" aria-label="Close modal" onClick={onClose}><X size={18} /></Button></header><div className="p-5">{children}</div>{footer && <footer className="border-t border-border-subtle px-5 py-4">{footer}</footer>}</div></div>, document.body)
}
