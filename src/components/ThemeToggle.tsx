import { useTheme } from '../theme/useTheme'
import type { ThemeChoice } from '../theme/context'

const ORDER: ThemeChoice[] = ['system', 'light', 'dark']
const LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' }
const GLYPH: Record<ThemeChoice, string> = { system: '◑', light: '☀', dark: '☾' }

/**
 * Cycles system → light → dark. Three states because "system" is a real answer, and a two-state
 * switch forces a choice the machine has usually already made correctly.
 *
 * The accessible name states the CURRENT theme and what pressing does, because the glyph alone
 * cannot: a moon can equally mean "you are in dark mode" or "switch to dark mode", and a screen
 * reader gets no help from the ambiguity.
 */
export default function ThemeToggle() {
  const { choice, resolved, setChoice } = useTheme()
  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]

  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      title={`Theme: ${LABEL[choice]}${choice === 'system' ? ` (${resolved})` : ''} — switch to ${LABEL[next]}`}
      aria-label={`Theme: ${LABEL[choice]}${choice === 'system' ? ` (currently ${resolved})` : ''}. Switch to ${LABEL[next]}.`}
      className="rounded-md border border-border-subtle px-2 py-1 text-sm text-agni-ink hover:border-agni-orange hover:text-agni-orange"
    >
      <span aria-hidden="true">{GLYPH[choice]}</span>
    </button>
  )
}
