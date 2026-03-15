// Shared color palette + helpers used by GraphCanvas and Inspector
// so the node badge color in the card always matches the graph node color.

export const COMMUNITY_PALETTE = [
  '#0a9396', // teal
  '#ee9b00', // amber
  '#005f73', // dark teal
  '#ca6702', // burnt orange
  '#94d2bd', // mint
  '#bb3e03', // brick
  '#ae2012', // red
  '#9b2226', // deep red
]

/**
 * Returns a stable hex color for a community.
 * Hashes the label string so "Lectures" is always the same color across
 * workspaces and rebuilds, regardless of how many groups exist.
 */
export function communityColor(id: number, label?: string): string {
  const key = label || String(id)
  let h = 5381
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h, 33) ^ key.charCodeAt(i)
    h = h >>> 0
  }
  return COMMUNITY_PALETTE[h % COMMUNITY_PALETTE.length]
}

/** Converts a hex color + alpha to rgba string. */
export function hexAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}
