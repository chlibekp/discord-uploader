export function toggleId(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Shift-click: add everything between the last-clicked tile and this one. */
export function rangeSelect(
  order: readonly string[],
  anchor: string | null,
  id: string,
  sel: ReadonlySet<string>,
): Set<string> {
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(id);
  if (a === -1 || b === -1) return toggleId(sel, id);
  const next = new Set(sel);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]!);
  return next;
}
