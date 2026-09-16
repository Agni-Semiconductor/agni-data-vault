import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ThemeContext, THEME_STORAGE_KEY } from './context'
import type { ResolvedTheme, ThemeChoice } from './context'

function readStoredChoice(): ThemeChoice {
  // Every storage access is wrapped: a private window, cleared site data, or a browser configured to
  // block storage makes this THROW rather than return null, and an exception here would take the
  // whole app down before it painted.
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* fall through to the default */
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  // Track the OS preference while the page is open. Without this, "system" is only correct until
  // someone flips their machine to dark at dusk with the tab already open.
  useEffect(() => {
    let media: MediaQueryList
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const update = () => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const resolved: ResolvedTheme = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice

  useEffect(() => {
    const root = document.documentElement
    // "system" REMOVES the attribute rather than writing the resolved value. Writing it would pin
    // the page to whatever the OS happened to be at load, and a later OS change would do nothing.
    if (choice === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', choice)
  }, [choice])

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      /* the choice still applies for this page; it just will not survive a reload */
    }
  }, [])

  const value = useMemo(() => ({ choice, resolved, setChoice }), [choice, resolved, setChoice])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
