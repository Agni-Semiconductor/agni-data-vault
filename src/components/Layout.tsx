import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, Link, Outlet, useMatches } from 'react-router-dom'
import clsx from 'clsx'
import { Button } from './ui'
import { useAuth } from '../auth/AuthProvider'
import ThemeToggle from './ThemeToggle'
import AskSidebar from './AskSidebar'
import { fitCount } from './fitCount'

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

function OverflowMenu({ links }: { links: { to: string; label: string }[] }) {
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
          {links.map((link) => (
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

/** One source for the link styling, so the measuring row cannot drift from the real one. */
const LINK_BASE = 'whitespace-nowrap border-b-2 px-3 py-1.5 text-sm'
const LINK_ACTIVE = 'border-agni-orange font-medium text-agni-orange'
const LINK_IDLE = 'border-transparent text-agni-ink hover:text-agni-orange'

/**
 * How many primary links fit, MEASURED rather than guessed.
 *
 * The bug this replaces: the nav is `min-w-0 flex-1`, so its box shrinks, but its children are
 * `whitespace-nowrap` and will not shrink below their text. They overflowed the box and painted
 * straight over the Ask button, the theme control and Sign out -- `scrollWidth` 601 against a
 * `clientWidth` of 165. Overlapping controls, all of them still clickable somewhere underneath.
 *
 * A media query cannot fix it. The space the nav gets is set by the assistant panel, not by the
 * window: opening the panel at 1024px leaves the bar 512px to work with while every `lg:` rule
 * still applies. Nor can a table of breakpoints -- the right-hand group carries the signed-in
 * email, so its width depends on whose it is.
 *
 * So: measure, ask the list how much room it actually has, and show the ones that fit. The rest
 * join the menu that already existed for the admin destinations, so nothing becomes unreachable --
 * it moves.
 *
 * MEASURED OFF A SEPARATE HIDDEN ROW, not off the visible links. Measuring the visible ones was my
 * first version and it is a trap: once a link has moved into the menu it is no longer in the list
 * to measure, so the cache can never be corrected. A first measurement taken before the webfont
 * swapped in was therefore permanent, and the bar sat one link short of what fits -- which is what
 * it did, showing five where six had room. The hidden row always holds every label, so a
 * re-measure is always possible.
 *
 * It measures the ACTIVE styling, which carries font-medium and is the wider of the two. Rounding
 * against the wider state means the estimate can only ever be generous, and a link that is one
 * pixel too eager is the failure mode that brought the overlap back.
 *
 * This cannot oscillate: the list is `flex-1` with a zero basis, so its width comes from the header
 * and its siblings, never from its own contents.
 */
function usePriorityNav(count: number) {
  const listRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(count)

  useLayoutEffect(() => {
    const list = listRef.current
    const row = measureRef.current
    if (!list || !row) return

    const fit = () => {
      const widths = [...row.children].map((el) => el.getBoundingClientRect().width)
      if (widths.length !== count) return
      // In jsdom every width is 0, so everything fits and the bar renders whole -- which is the
      // right answer for a test that is reading structure rather than pixels.
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0
      setVisible(fitCount(widths, list.clientWidth, gap))
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(list)
    observer.observe(row)
    // A webfont swapping in changes the width of every label, so the first measurement -- taken
    // against whatever face was available -- is provisional.
    document.fonts?.ready.then(fit).catch(() => undefined)
    return () => observer.disconnect()
  }, [count])

  return { listRef, measureRef, visible }
}

export default function Layout() {
  const { user, signOut } = useAuth()
  const [askOpen, setAskOpen] = useState(false)
  const { listRef, measureRef, visible } = usePriorityNav(primaryLinks.length)
  // The links that did not fit are not dropped, they move: the menu is the same one the admin
  // destinations already live in, so there is one place to look for anything not on the bar.
  const barLinks = primaryLinks.slice(0, visible)
  const menuLinks = [...primaryLinks.slice(visible), ...overflowLinks]
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
  // max-w-7xl (1280px) left roughly a third of a 2000px window empty on either side, which read
  // as the page being cropped rather than centred. The cap is now wide enough to be invisible on a
  // normal display and still bounded, because an unbounded line length on an ultrawide is its own
  // readability problem; wide routes keep opting out entirely.
  const container = clsx('mx-auto w-full px-8', wideMain ? 'max-w-none' : 'max-w-[1920px]')

  return (
    /* A ROW, not a stack with something floating over it. The content column and the assistant
     * share the width, so opening the panel COMPRESSES the page rather than covering it and
     * everything on the left stays interactive -- scroll the table, change a filter, click a row,
     * with the panel still open. min-w-0 is what actually lets the column give up space; without
     * it a wide table refuses to shrink and pushes the panel off-screen instead.
     *
     * overflow-x-clip because the CLOSED panel is parked past the right edge on a negative
     * margin. Clip, not hidden: hidden would make this a scroll container and break the
     * panel's sticky positioning, which is the whole reason it stays put while the page
     * scrolls beside it. */
    <div className="flex min-h-screen overflow-x-clip bg-surface-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="border-b border-border-subtle bg-surface-1">
        <div className={clsx(container, 'flex items-center gap-x-6 py-4')}>
          <Link to="/" className="flex shrink-0 items-center gap-3">
            {/* agni-logo-transparent.png is the shipped PNG with its white background keyed out
                and the surrounding padding trimmed. The original is composited ink on white, so
                the alpha is its distance from white and the ink colour is recovered by removing
                the white mixed into it; interior pixels are forced opaque so the mark does not
                composite the page through itself on a dark ground, while edge pixels keep their
                computed alpha and stay antialiased. The ink is orange and gold with no dark
                pixels at all, so one asset reads correctly in both themes. */}
            <img src="/agni-logo-transparent.png" alt="Agni" className="h-6 w-auto" />
            <span className="label-caps">DATA VAULT</span>
          </Link>
          {/* min-w-0 lets the nav shrink instead of forcing the row to wrap, which is what pushed
              "Vocabularies" onto a second line. */}
          <nav className="relative flex min-w-0 flex-1 items-center gap-1">
            {/* The ruler. Never shown, never focusable, never read out -- it exists only so every
                label can still be measured after it has moved into the menu. It is absolutely
                positioned so it takes no space, and the shell's overflow-x-clip keeps it from
                widening the page. */}
            <div
              ref={measureRef}
              aria-hidden="true"
              inert
              className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-1"
            >
              {primaryLinks.map((link) => (
                <span key={link.to} className={clsx(LINK_BASE, LINK_ACTIVE)}>
                  {link.label}
                </span>
              ))}
            </div>
            {/* The measured list. overflow-hidden is the backstop for the frame before the first
                measurement lands -- a link may be clipped there, but nothing is ever painted over
                the controls to the right. The menu is its SIBLING, not inside it, because the
                dropdown is absolutely positioned and this box would clip it away. */}
            <div ref={listRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {barLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) => clsx(LINK_BASE, isActive ? LINK_ACTIVE : LINK_IDLE)}
              >
                {link.label}
              </NavLink>
            ))}
            </div>
            <OverflowMenu links={menuLinks} />
          </nav>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setAskOpen((value) => !value)}
              aria-expanded={askOpen}
              aria-controls="ask-panel"
              className={clsx(
                'rounded-md border px-2 py-1 text-sm',
                askOpen
                  ? 'border-agni-orange text-agni-orange'
                  : 'border-border-subtle text-agni-ink hover:border-agni-orange hover:text-agni-orange',
              )}
            >
              Ask
            </button>
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
      <AskSidebar id="ask-panel" open={askOpen} onClose={() => setAskOpen(false)} />
    </div>
  )
}
