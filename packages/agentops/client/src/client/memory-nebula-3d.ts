/**
 * Deterministic galaxy layout and dust for the memory nebula.
 *
 * Visual positions are hashed from stable ids, so the same project data always
 * renders the same star field. The dust layer is procedural, not random per
 * refresh.
 *
 * @module @agentops/dsh-client/memory-nebula-3d
 */

import type { MemoryNebula, NebulaNode } from './memory-nebula-model.ts'

export const DISC_RADIUS = 900

function rand(seed: number, salt: number): number {
  const value = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return Math.abs(value)
}

export interface GalaxyDust {
  readonly positions: Float32Array
  readonly colors: Float32Array
}

/** Two-armed galactic disc with Gaussian thickness, in Three.js coordinates. */
export function galaxyDust(count: number): GalaxyDust {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  for (let index = 0; index < count; index++) {
    const radius = DISC_RADIUS * Math.sqrt(rand(index, 1))
    const armPhase = radius * 0.006
    const armPick = rand(index, 2) > 0.5 ? 0 : Math.PI
    const theta = rand(index, 3) * Math.PI * 2 + armPhase + armPick
    const gaussian = (rand(index, 4) + rand(index, 5) + rand(index, 6) - 1.5)
      * 46 * Math.exp(-radius / (DISC_RADIUS * 0.6))
    positions[index * 3] = Math.cos(theta) * radius
    positions[index * 3 + 1] = gaussian
    positions[index * 3 + 2] = Math.sin(theta) * radius
    const warm = rand(index, 7) > 0.9
    const brightness = (0.5 + rand(index, 8) * 0.5) * (1 - radius / (DISC_RADIUS * 1.8))
    colors[index * 3] = warm ? 0.95 : 0.55 * brightness + 0.28
    colors[index * 3 + 1] = warm ? 0.78 : 0.68 * brightness + 0.22
    colors[index * 3 + 2] = warm ? 0.48 : 0.95
  }
  return { positions, colors }
}

/** Assign deterministic disc positions while preserving 3D world coordinates. */
export function layoutNebula(graph: MemoryNebula): MemoryNebula {
  const clusters = new Map<string, NebulaNode[]>()
  for (const node of graph.nodes) {
    const key = node.kind === 'task' ? '任务执行' : node.category
    const bucket = clusters.get(key) ?? []
    bucket.push(node)
    clusters.set(key, bucket)
  }
  const keys = [...clusters.keys()].sort((left, right) => left.localeCompare(right))
  keys.forEach((clusterKey, clusterIndex) => {
    const members = clusters.get(clusterKey) ?? []
    const angle = (clusterIndex / Math.max(1, keys.length)) * Math.PI * 2 + 0.6
    const baseRadius = DISC_RADIUS * (0.34 + (clusterIndex % 3) * 0.13)
    const centerX = Math.cos(angle) * baseRadius
    const centerZ = Math.sin(angle) * baseRadius
    const centerY = Math.sin(clusterIndex * 1.9) * 40
    members.forEach((node, index) => {
      const seed = hash(node.id)
      const ring = Math.sqrt(index + 1)
      const spiral = index * 2.399963
      const decay = node.kind === 'task' ? 0.3 : 0.6
      const radius = ring * 20 * (1 + decay * 0.6) + seed % 24
      node.x = centerX + Math.cos(spiral) * radius
      node.z = centerZ + Math.sin(spiral) * radius
      node.y = centerY + Math.sin(index * 1.7 + clusterIndex) * 16
    })
  })
  return { ...graph, nodes: graph.nodes }
}
