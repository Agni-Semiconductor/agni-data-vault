import { useEffect, useRef, useState } from 'react'
import { NavLink, Link, Outlet, useMatches } from 'react-router-dom'
import clsx from 'clsx'
import { Button } from './ui'
import { useAuth } from '../auth/AuthProvider'
import ThemeToggle from './ThemeToggle'
import AskSidebar from './AskSidebar'

/**
 * Primary navigation, and a deliberately short list.
 *
 * Eleven links in a `flex-wrap` inside a 1280px header wrapped onto a second row, which is what
 * "the top bar isn't wide enough" actually was: not a width problem but a count problem. The three
 * administrative destinations move into an overflow menu, and Ask leaves the bar entirely -- it is
 * a panel now, reachable from every page rather than being somewhere you navigate to and lose your
 * place.
 */
const primaryLinks = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/samples', label: 'Samples' },
  { to: '/upload', label: 'Upload' },
  { to: '/review', label: 'Review' },
  { to: '/bench', label: 'Bench' },
  { to: '/cohorts', label: 'Cohorts' },
  { to: '/figures', label: 'Figures' },
]

const overflowLinks = [
  { to: '/verdict-changes', label: 'Verdict changes' },
  { to: '/admin/fields', label: 'Admin: Fields' },
  { to: '/admin/vocab', label: 'Vocabularies' },
]

function OverflowMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    // Escape as well as an outside click: a menu you can only dismiss with the mouse is a menu that
    // traps anyone working from the keyboard.
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="border-b-2 border-transparent px-3 py-1.5 text-sm text-agni-ink hover:text-agni-orange"
      >
        More <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 min-w-52 rounded-md border border-border-subtle bg-surface-1 py-1 shadow-overlay"
        >
          {overflowLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                clsx('block px-3 py-1.5 text-sm hover:bg-surface-2', isActive ? 'text-agni-orange' : 'text-agni-ink')
              }
            >
              {link.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default function Layout() {
  const { user, signOut } = useAuth()
  const matches = useMatches()
  const wideMain = matches.some((match) => (match.handle as { wideMain?: boolean } | undefined)?.wideMain)

  /**
   * ONE width for the header, the main region and the footer.
   *
   * The header was pinned at max-w-7xl while main became max-w-none on wide routes, so on
   * /verdict-changes, /cohorts and the figure builder the content started to the LEFT of the
   * header's left edge and ran past its right. That misalignment was the "offset weird" report --
   * a layout bug, not a styling preference. Whatever the width is, all three now share it.
   */
  const container = clsx('mx-auto w-full px-6', wideMain ? 'max-w-none' : 'max-w-7xl')

  return (
    <div className="flex min-h-screen flex-col bg-surface-1">
      <header className="border-b border-border-subtle bg-surface-1">
        <div className={clsx(container, 'flex items-center gap-x-6 py-4')}>
          <Link to="/" className="flex shrink-0 items-center gap-3">
            {/* The logo PNG is fully opaque with a baked-in white background -- verified: all four
                corners are #FFFFFF at alpha 255 -- so on a dark ground it renders as a white
                rectangle. Until there is a transparent or dark-variant asset, the white is made
                DELIBERATE: a small padded chip reads as a badge rather than as a rendering fault.
                bg-[#FFFFFF] is an explicit literal on purpose; `bg-white` is remapped to the theme
                surface in index.css, which is exactly what must not happen here. */}
            <span className="inline-flex items-center rounded-[3px] bg-[#FFFFFF] px-1.5 py-1">
              <img src="/agni-logo.png" alt="Agni" className="h-5 w-auto" />
            </span>
            <span className="label-caps">DATA VAULT</span>
          </Link>
          {/* min-w-0 lets the nav shrink instead of forcing the row to wrap, which is what pushed
              "Vocabularies" onto a second line. */}
          <nav className="flex min-w-0 flex-1 items-center gap-1">
            {primaryLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  clsx(
                    'whitespace-nowrap border-b-2 px-3 py-1.5 text-sm',
                    isActive
                      ? 'border-agni-orange font-medium text-agni-orange'
                      : 'border-transparent text-agni-ink hover:text-agni-orange',
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
            <OverflowMenu />
          </nav>
          <div className="flex shrink-0 items-center gap-3">
            <AskSidebar />
            <ThemeToggle />
            <span className="hidden max-w-48 truncate font-mono text-xs text-agni-slate lg:inline">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className={clsx(container, 'flex-1 py-6')}>
        <Outlet />
      </main>
      <footer className={clsx(container, 'flex justify-between border-t border-border-subtle py-4')}>
        <span className="label-caps">AGNI CONFIDENTIAL</span>
        <span className="text-xs text-agni-slate">Agni Data Vault © Agni Semiconductor</span>
      </footer>
    </div>
  )
}
