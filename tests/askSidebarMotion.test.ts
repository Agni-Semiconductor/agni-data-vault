// @ts-nocheck
// The panel's motion is a layout contract, not a decoration, so it is pinned here.
//
// The defect being guarded: the first version unmounted the panel when closed and animated a
// transform on the way in. The row therefore reflowed to its final columns on frame one -- the page
// snapped narrower -- and only then did the panel travel across the gap it had already made. Two
// motions out of step, which reads as a jolt followed by a slide.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const sidebar = read('src/components/AskSidebar.tsx');
const layout = read('src/components/Layout.tsx');
const css = read('src/index.css');

describe('the assistant panel slides rather than appearing', () => {
  it('stays mounted when closed, because there is nothing to animate from otherwise', () => {
    expect(sidebar, 'unmounting the panel is what caused the jolt').not.toMatch(/if \(!open\) return null/);
    expect(sidebar).toMatch(/data-open=\{open \? 'true' : 'false'\}/);
  });

  it('animates the space the panel occupies, not the panel over it', () => {
    // margin-inline-end is the width the content column gives up. Transitioning it is what makes
    // the compression and the entrance the same motion.
    expect(css).toMatch(/\.ask-panel\s*\{[^}]*transition:\s*margin-inline-end/);
    expect(css, 'the old transform entrance must not come back').not.toMatch(/@keyframes ask-panel-in/);
  });

  it('derives the parked margin from the same custom property as the width', () => {
    // Two places holding the same number is how a panel ends up not quite parked. The closed
    // margin must be the negation of the width, computed, never a second literal.
    expect(css).toMatch(/\.ask-panel\s*\{[^}]*width:\s*var\(--ask-width\)/);
    expect(css).toMatch(/\.ask-panel\[data-open='false'\]\s*\{\s*margin-inline-end:\s*calc\(var\(--ask-width\) \* -1\)/);
    expect(css).toMatch(/\.ask-panel\[data-open='true'\]\s*\{\s*margin-inline-end:\s*0/);
  });

  it('honours a stated preference for less motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.ask-panel')));
    expect(reduced).toMatch(/\.ask-panel\s*\{\s*transition:\s*none/);
  });

  it('clips the row so the parked panel costs no horizontal scrollbar', () => {
    // clip, not hidden: hidden makes the row a scroll container and breaks the panel's sticky
    // positioning, which is what keeps it in place while the page scrolls beside it.
    expect(layout).toMatch(/flex min-h-screen overflow-x-clip/);
    expect(layout, 'overflow-hidden would break sticky').not.toMatch(/flex min-h-screen overflow-hidden/);
  });

  it('takes the closed panel out of the tab order it is still sitting in', () => {
    // A panel that stays in the document but is parked off-screen is a keyboard trap unless it is
    // inert -- worse than the jolt this change was made to fix.
    expect(sidebar).toMatch(/inert=\{!open\}/);
  });
});
