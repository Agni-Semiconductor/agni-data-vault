import { useContext } from 'react'
import { ThemeContext } from './context'
import type { ThemeContextValue } from './context'

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  // A default rather than a throw: canvas components call this, and a chart that renders with light
  // ink is a far better failure than a page that renders nothing.
  if (!context) return { choice: 'system', resolved: 'light', setChoice: () => {} }
  return context
}

/**
 * Read a themed CSS variable as a concrete colour string.
 *
 * Canvas and SVG drawing code cannot use a Tailwind utility or a var() in a fill, so it has to ask
 * the document what the token currently resolves to. Components that did this by reading
 * `prefers-color-scheme` directly were wrong the moment an explicit toggle existed: the page would
 * be dark and the plot drawn for light.
 *
 * Call it during render, not once at module load -- the value changes when the theme does, and a
 * colour captured at import time is pinned to whatever the theme happened to be on first paint.
 */
export function themeColor(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  } catch {
    return fallback
  }
}
