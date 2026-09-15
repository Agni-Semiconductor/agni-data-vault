// @ts-nocheck
// The header overlap, pinned.
//
// What it looked like: the nav is `min-w-0 flex-1` so its box shrinks, but its links are
// `whitespace-nowrap` and will not shrink below their text. They overflowed and painted over the
// Ask button, the theme control and Sign out -- scrollWidth 601 against clientWidth 165. Every
// control still worked; they were just drawn on top of one another.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitCount } from '../src/components/fitCount';

const layout = readFileSync(resolve(process.cwd(), 'src/components/Layout.tsx'), 'utf8');

describe('how many links fit', () => {
  // Real measurements from the running header: Dashboard 93.7, Samples 79.4, Upload 69.7,
  // Review 70.4, Bench 64.4, Cohorts 74.2, Figures 71.3, with a 4px gap.
  const real = [93.7, 79.4, 69.7, 70.4, 64.4, 74.2, 71.3];

  it('takes everything when there is room', () => {
    expect(fitCount(real, 1036, 4)).toBe(7);
  });

  it('stops at the last one that actually fits', () => {
    // Five come to 393.6 and six to 471.8, so 460px of room takes five.
    expect(fitCount(real, 460, 4)).toBe(5);
    expect(fitCount(real, 471.8, 4)).toBe(6);
    expect(fitCount(real, 471.7, 4)).toBe(5);
  });

  it('charges no gap before the first item', () => {
    // Charging one here is how a bar ends up one link short at exactly the width where it was
    // complete -- and, with a single link, shows nothing at all.
    expect(fitCount([100], 100, 4)).toBe(1);
    expect(fitCount([100, 100], 204, 4)).toBe(2);
    expect(fitCount([100, 100], 203, 4)).toBe(1);
  });

  it('gives up cleanly rather than showing a link that does not fit', () => {
    expect(fitCount(real, 12, 4)).toBe(0);
    expect(fitCount(real, 0, 4)).toBe(0);
  });

  it('keeps the order of the list, which is a statement about priority', () => {
    // Not "whichever happen to be narrow enough": a narrow Figures must never displace Dashboard.
    expect(fitCount([200, 10, 10], 100, 0)).toBe(0);
  });

  it('reports everything fitting when nothing has been measured yet', () => {
    // jsdom gives every element a width of 0, and so does the first layout pass. Without a special
    // case the arithmetic fits exactly one item and drops the rest, so the bar would render as a
    // single link and grow. Complete-then-corrected is the safe direction.
    expect(fitCount([0, 0, 0], 0, 4)).toBe(3);
    expect(fitCount([0, 0, 0], 800, 4)).toBe(3);
  });

  it('still refuses a real measurement that does not fit', () => {
    // The zero case must not become "when in doubt, show everything". One measured item among
    // zeroes is a real measurement and is treated as one.
    // The shortcut fires only when EVERY width is zero. One real measurement among them is a
    // measurement, and the item that does not fit is still refused.
    expect(fitCount([0, 0, 80], 60, 4)).toBe(2);
    expect(fitCount([], 800, 4)).toBe(0);
  });
});

describe('the header cannot paint its links over the controls again', () => {
  it('renders only the links that fit, and clips whatever a stale frame leaves over', () => {
    expect(layout).toMatch(/barLinks = primaryLinks\.slice\(0, visible\)/);
    // The clip is the backstop for the frame before the first measurement lands. Without it the
    // links overflow the box and paint over the Ask button, which is the original defect.
    expect(layout).toMatch(/ref=\{listRef\}[\s\S]{0,120}overflow-hidden/);
  });

  it('moves what did not fit into the menu instead of dropping it', () => {
    // Unreachable is worse than crowded. Every primary link is either on the bar or in the menu.
    expect(layout).toMatch(/menuLinks = \[\.\.\.primaryLinks\.slice\(visible\), \.\.\.overflowLinks\]/);
    expect(layout).toMatch(/<OverflowMenu links=\{menuLinks\}/);
  });

  it('measures off a hidden row that always holds every label', () => {
    // Measuring the visible links cannot work: once a link moves into the menu it is gone from the
    // list, so a measurement taken before the webfont loaded could never be corrected, and the bar
    // sat one link short of what fits.
    expect(layout).toMatch(/ref=\{measureRef\}/);
    expect(layout).toMatch(/aria-hidden="true"/);
    expect(layout, 'the ruler must not be reachable by keyboard').toMatch(/ref=\{measureRef\}[\s\S]{0,200}inert/);
    expect(layout, 'the ruler must not take space').toMatch(/ref=\{measureRef\}[\s\S]{0,300}absolute/);
  });

  it('measures the wider of the two link styles', () => {
    // The active link carries font-medium. Measuring the idle weight would under-reserve and let
    // the active link overflow by a pixel or two -- which is the overlap, back again.
    expect(layout).toMatch(/clsx\(LINK_BASE, LINK_ACTIVE\)/);
    expect(layout, 'one source for both, or the ruler drifts from the real links')
      .toMatch(/clsx\(LINK_BASE, isActive \? LINK_ACTIVE : LINK_IDLE\)/);
  });

  it('re-measures when the space changes, including when the assistant opens', () => {
    // A media query cannot see the panel: it takes 448px of a 1024px window while every lg: rule
    // still applies. The observer watches the element whose width actually changed.
    expect(layout).toMatch(/new ResizeObserver/);
    expect(layout).toMatch(/observer\.observe\(list\)/);
    expect(layout).toMatch(/document\.fonts\?\.ready/);
    expect(layout).toMatch(/observer\.disconnect\(\)/);
  });
});
