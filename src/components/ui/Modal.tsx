import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from './Button'
const sizes = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const
export function Modal({ open, onClose, title, children, footer, size = 'lg' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: 'md' | 'lg' | 'xl' }) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!open) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; document.addEventListener('keydown', close); const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; const first = dialog.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'); first?.focus(); return () => { document.removeEventListener('keydown', close); document.body.style.overflow = previous } }, [onClose, open])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} className={`relative flex w-full flex-col ${sizes[size]} max-h-[calc(100vh-4rem)] rounded-lg border border-border-subtle bg-white shadow-overlay`}>
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle bg-white px-5 py-3"><h2 className="text-lg font-semibold">{title}</h2><Button variant="ghost" size="sm" aria-label="Close modal" onClick={onClose}><X size={18} /></Button></header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-border-subtle bg-white px-5 py-3">{footer}</footer>}
      </div>
    </div>, document.body)
}
