import type { PaneLeaf, PaneNode, PaneSplit } from './types'

export function getLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return [...getLeaves(node.children[0]), ...getLeaves(node.children[1])]
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId)
}

export function findLeafByTabId(node: PaneNode, tabId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.tabs.some((t) => t.id === tabId) ? node : null
  return (
    findLeafByTabId(node.children[0], tabId) || findLeafByTabId(node.children[1], tabId)
  )
}

export function hasAnyTabs(node: PaneNode): boolean {
  if (node.type === 'leaf') return node.tabs.length > 0
  return hasAnyTabs(node.children[0]) || hasAnyTabs(node.children[1])
}

export function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.type === 'leaf') return fn(node)
  const left = mapLeaves(node.children[0], fn)
  const right = mapLeaves(node.children[1], fn)
  if (left === node.children[0] && right === node.children[1]) return node
  return { ...node, children: [left, right] }
}

export function replaceNode(
  root: PaneNode,
  nodeId: string,
  replacement: PaneNode
): PaneNode {
  if (root.id === nodeId) return replacement
  if (root.type === 'leaf') return root
  const left = replaceNode(root.children[0], nodeId, replacement)
  const right = replaceNode(root.children[1], nodeId, replacement)
  if (left === root.children[0] && right === root.children[1]) return root
  return { ...root, children: [left, right] }
}

/** Remove a leaf by id. If the leaf is a child of a split, the split
 * collapses to the remaining sibling. Returns null if the root itself
 * is the removed leaf. */
export function removeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.type === 'leaf') return root.id === leafId ? null : root
  const [left, right] = root.children
  if (left.type === 'leaf' && left.id === leafId) return right
  if (right.type === 'leaf' && right.id === leafId) return left
  const newLeft = removeLeaf(left, leafId)
  if (newLeft !== left) {
    return newLeft === null ? right : { ...root, children: [newLeft, right] }
  }
  const newRight = removeLeaf(right, leafId)
  if (newRight !== right) {
    return newRight === null ? left : { ...root, children: [left, newRight] }
  }
  return root
}

export function findSplit(node: PaneNode, splitId: string): PaneSplit | null {
  if (node.type === 'leaf') return null
  if (node.id === splitId) return node
  return findSplit(node.children[0], splitId) || findSplit(node.children[1], splitId)
}
