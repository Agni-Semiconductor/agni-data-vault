/**
 * How many items from the front of a list fit in `available`, laid out in a row with `gap` between
 * them.
 *
 * Its own file because it is the part worth testing, and testing it through the header means
 * standing up a router, an auth provider and a layout just to ask an arithmetic question. It is
 * also the part that was wrong twice: once counting a gap before the first item, and once
 * measuring against a cache that could never be refreshed.
 *
 * Greedy from the front on purpose. The order of the primary navigation is a statement about what
 * matters, so the links that survive a narrow window must be the first ones, never whichever
 * happen to be narrow enough to slot in.
 */
export function fitCount(widths: number[], available: number, gap: number): number {
  // NOT MEASURED YET is not the same as DOES NOT FIT. Before the first layout -- and in jsdom,
  // where nothing has a size at all -- every width reads 0, and the arithmetic below would then
  // fit exactly one item and drop the rest. Answering "all of them" is the safe direction: the bar
  // renders complete and is corrected a frame later, rather than rendering as a single link and
  // growing. Real rendered text is never 0 wide, so this cannot mask a genuine result.
  if (widths.length > 0 && widths.every((width) => width === 0)) return widths.length

  let used = 0
  let fits = 0
  for (const width of widths) {
    // No gap before the first item. Charging one there is how a list ends up one item short at
    // exactly the width where it should have been complete.
    const next = used + (fits > 0 ? gap : 0) + width
    if (next > available) break
    used = next
    fits += 1
  }
  return fits
}
