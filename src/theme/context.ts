import { createContext } from 'react'

/**
 * Three states, not two. "system" is the default and stamps NOTHING on <html>, so the page follows
 * prefers-color-scheme; "light" and "dark" stamp data-theme and win over the OS in both directions.
 *
 * A two-state toggle cannot express "follow the machine", and defaulting to light on a dark OS is
 * the thing people notice first.
 */
export type ThemeChoice = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'agni.theme'

export type ThemeContextValue = {
  /** What the user chose, including "system". */
  choice: ThemeChoice
  /** What that currently resolves to -- the value canvas and SVG code needs. */
  resolved: ResolvedTheme
  setChoice: (next: ThemeChoice) => void
}

/**
 * The context, the types and the storage key live here so ThemeProvider.tsx can export a component
 * and nothing else. Mixing a hook or a constant into a component module silently disables React
 * fast refresh for that file, which is a development-speed tax nobody attributes to the right cause.
 */
export const ThemeContext = createContext<ThemeContextValue | null>(null)
