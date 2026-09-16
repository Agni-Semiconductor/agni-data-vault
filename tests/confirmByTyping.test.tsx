// The gating rule for every destructive confirmation in the app, tested once because it exists
// once. Two copies of this dialog would drift -- the browser and the server each grew their own
// filename cleaner in this codebase and produced different storage paths for the same file.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConfirmByTyping from '../src/components/ConfirmByTyping'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function render(props: Partial<Parameters<typeof ConfirmByTyping>[0]> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <ConfirmByTyping
        open
        onClose={() => {}}
        title="Delete thing"
        phrase="AG-2026-014"
        description="This destroys the thing."
        confirmLabel="Delete thing"
        inputId="confirm-input"
        inputLabel="Type to confirm"
        {...props}
        onConfirm={onConfirm}
      />,
    )
  })
  const input = document.querySelector<HTMLInputElement>('#confirm-input')!
  const button = [...document.querySelectorAll('button')].find((b) => /delete thing/i.test(b.textContent ?? ''))!
  const type = (value: string) => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return { input, button, type, onConfirm }
}

describe('ConfirmByTyping', () => {
  it('enables the action only on an exact match', () => {
    const { button, type } = render()
    expect(button.disabled, 'empty must be blocked').toBe(true)
    type('AG-2026-01')
    expect(button.disabled, 'a prefix must be blocked').toBe(true)
    type('AG-2026-014')
    expect(button.disabled, 'the exact phrase must enable it').toBe(false)
  })

  it('refuses the near-misses that muscle memory produces', () => {
    // THE POINT OF THE COMPONENT. The failure being prevented is typing something plausible and
    // hitting Enter, so every accommodation -- trim, case folding -- makes the barrier easier to
    // clear without reading it.
    const { button, type } = render()
    // No newline case: an <input> STRIPS newlines from its value, so 'AG-2026-014' plus one becomes
    // an exact match -- and cannot be typed into a single-line field anyway. Asserting it would
    // be asserting that the browser is something other than it is.
    for (const near of ['AG-2026-014 ', ' AG-2026-014', 'ag-2026-014', 'AG-2026-0141']) {
      type(near)
      expect(button.disabled, `"${near}" must not enable the action`).toBe(true)
    }
    type('AG-2026-014')
    expect(button.disabled, 'and the exact phrase still must').toBe(false)
  })

  it('does not fire the action twice on a double click', () => {
    // Without a busy gate the second click fires against a row that is already gone, and the 404
    // surfaces as an error on a delete that actually succeeded.
    let resolve: () => void = () => {}
    const onConfirm = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    const { button, type } = render({ onConfirm })
    type('AG-2026-014')
    act(() => { button.click() })
    act(() => { button.click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    act(() => resolve())
  })

  it('forgets what was typed when it closes', () => {
    // A dialog that reopens already satisfied is a one-click delete wearing the costume of a
    // two-step one.
    const { button, type } = render()
    type('AG-2026-014')
    expect(button.disabled).toBe(false)
    act(() => { root!.render(<ConfirmByTyping open={false} onClose={() => {}} title="Delete thing" phrase="AG-2026-014" description="x" confirmLabel="Delete thing" inputId="confirm-input" inputLabel="Type to confirm" onConfirm={vi.fn()} />) })
    act(() => { root!.render(<ConfirmByTyping open onClose={() => {}} title="Delete thing" phrase="AG-2026-014" description="x" confirmLabel="Delete thing" inputId="confirm-input" inputLabel="Type to confirm" onConfirm={vi.fn()} />) })
    const reopened = [...document.querySelectorAll('button')].find((b) => /delete thing/i.test(b.textContent ?? ''))!
    expect(reopened.disabled, 'reopening must require typing the phrase again').toBe(true)
  })
})

describe('neither detail page offers delete on its primary view', () => {
  // Source-level, because the property is about WHERE the control lives. Both pages were shipped
  // with a one-click delete on the page you land on; a sample delete also destroys its
  // measurements and their files.
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

  it('the sample page keeps its danger zone inside the edit surface', () => {
    const source: string = read('src/pages/SampleDetail.tsx')
    const editModal = source.slice(source.indexOf('title="Edit sample"'))
    expect(editModal, 'the danger zone must live in the edit modal').toMatch(/Danger zone/)
    const body = source.slice(0, source.indexOf('title="Edit sample"'))
    expect(body, 'and must not appear in the page body').not.toMatch(/Danger zone/)
    expect(source, 'window.confirm is not a barrier; it is one keypress').not.toMatch(
      /window\.confirm\([^)]*sample_id/,
    )
  })

  it('both pages use the shared confirmation rather than their own', () => {
    for (const page of ['src/pages/SampleDetail.tsx', 'src/pages/MeasurementDetail.tsx']) {
      expect(read(page), `${page} must use ConfirmByTyping`).toMatch(/ConfirmByTyping/)
    }
  })
})
