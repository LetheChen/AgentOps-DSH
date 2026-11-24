/**
 * Force-directed 3D layout and ambient dust for the memory nebula.
 *
 * Structural edges pull domains, subdomains and documents together while
 * cross-domain tag nodes bridge otherwise separate constellations. Domain
 * nodes are anchored on a deterministic sphere so refreshes keep the same
 * overall shape without freezing the graph into a decorative scatter.
 *
 * @module @agentops/dsh-client/memory-nebula-3d
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  forceZ,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force-3d'

import { nodeRadius, type MemoryNebula, type NebulaNode } from './memory-nebula-model.ts'

/** Radius of the ambient dust disc, in world units. */
export const DISC_RADIUS = 900
const DOMAIN_RADIUS = 330

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

/** Position and color buffers of the ambient dust field. */
export interface GalaxyDust {
  readonly positions: Float32Array
  readonly colors: Float32Array
}

/**
 * Two-armed galactic disc with Gaussian thickness, in Three.js coordinates.
 * @param count - number of dust points to generate.
 * @param seedOffset - offset applied to the per-point seed.
 * @returns the position and color buffers of the dust field.
 */
export function galaxyDust(count: number, seedOffset = 0): GalaxyDust {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  for (let index = 0; index < count; index++) {
    const seed = index + seedOffset
    const radius = DISC_RADIUS * Math.sqrt(rand(seed, 1))
    const armPhase = radius * 0.006
    const armPick = rand(seed, 2) > 0.5 ? 0 : Math.PI
    const theta = rand(seed, 3) * Math.PI * 2 + armPhase + armPick
    const gaussian = (rand(seed, 4) + rand(seed, 5) + rand(seed, 6) - 1.5)
      * 46 * Math.exp(-radius / (DISC_RADIUS * 0.6))
    positions[index * 3] = Math.cos(theta) * radius
    positions[index * 3 + 1] = gaussian
    positions[index * 3 + 2] = Math.sin(theta) * radius
    const warm = rand(seed, 7) > 0.88
    const brightness = (0.55 + rand(seed, 8) * 0.45) * (1 - radius / (DISC_RADIUS * 2))
    colors[index * 3] = warm ? 0.95 : 0.28 * brightness + 0.28
    colors[index * 3 + 1] = warm ? 0.68 : 0.55 * brightness + 0.32
    colors[index * 3 + 2] = warm ? 0.36 : 1
  }
  return { positions, colors }
}

type LayoutNode = NebulaNode & SimulationNodeDatum

interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  readonly id: string
  readonly kind: string
}

interface Point3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

function linkDistance(link: LayoutLink): number {
  if (link.kind === 'contains') return 72
  if (link.kind === 'tagged') return 88
  if (link.kind === 'blocks') return 48
  if (link.kind === 'originated_from') return 86
  return 68
}

function linkStrength(link: LayoutLink): number {
  if (link.kind === 'contains') return 0.72
  if (link.kind === 'tagged') return 0.18
  if (link.kind === 'blocks') return 0.85
  if (link.kind === 'originated_from') return 0.18
  return 0.25
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function domainAnchors(nodes: readonly LayoutNode[]): Map<string, Point3> {
  const domains = nodes.filter(node => node.kind === 'domain').sort((left, right) => left.id.localeCompare(right.id))
  const anchors = new Map<string, Point3>()
  const golden = Math.PI * (3 - Math.sqrt(5))
  domains.forEach((node, index) => {
    const y = domains.length === 1 ? 0 : 1 - (2 * (index + 0.5)) / domains.length
    const ring = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = index * golden + 0.35
    const point = {
      x: Math.cos(theta) * ring * DOMAIN_RADIUS,
      y: y * DOMAIN_RADIUS * 0.68,
      z: Math.sin(theta) * ring * DOMAIN_RADIUS,
    }
    anchors.set(node.domainId ?? node.sourceRef ?? node.id, point)
  })
  return anchors
}

function initialPosition(node: LayoutNode, anchor: Point3 | undefined): Point3 {
  if (node.kind === 'domain' && anchor !== undefined) return anchor
  const seed = hash(node.id)
  const base = anchor ?? { x: 0, y: 0, z: 0 }
  const spread = node.kind === 'subdomain' ? 120 : node.kind === 'knowledge' ? 150 : node.kind === 'tag' ? 220 : 90
  const angle = (seed % 360) / 180 * Math.PI
  const vertical = ((Math.floor(seed / 13) % 200) - 100) / 100
  const ring = Math.sqrt((seed % 97) / 97) * spread
  return {
    x: base.x + Math.cos(angle) * ring,
    y: base.y + vertical * spread * 0.62,
    z: base.z + Math.sin(angle) * ring,
  }
}

/**
 * Run a deterministic 3D force simulation and return stable world positions.
 * @param graph - domain, subdomain, tag, task, memory and document nodes.
 * @returns a graph with force-laid-out positions.
 */
export function layoutNebula(graph: MemoryNebula): MemoryNebula {
  if (graph.nodes.length === 0) return graph
  const nodes: LayoutNode[] = graph.nodes.map((node, index) => ({
    ...node,
    index,
    vx: 0,
    vy: 0,
    vz: 0,
  }))
  const links: LayoutLink[] = graph.links.map(link => ({
    id: link.id,
    kind: link.kind,
    source: link.source,
    target: link.target,
  }))
  const anchors = domainAnchors(nodes)
  const anchorFor = (node: LayoutNode): Point3 | undefined => node.domainId === undefined ? undefined : anchors.get(node.domainId)
  const positioned = new Map<string, Point3>()
  for (const node of nodes) {
    const anchor = anchorFor(node)
    const point = initialPosition(node, anchor)
    node.x = point.x
    node.y = point.y
    node.z = point.z
    positioned.set(node.id, point)
    if (node.kind === 'domain') {
      node.fx = point.x
      node.fy = point.y
      node.fz = point.z
    }
  }

  const fallback = (node: LayoutNode): Point3 => anchorFor(node) ?? positioned.get(node.id) ?? { x: 0, y: 0, z: 0 }
  const simulation = forceSimulation(nodes, 3)
    .randomSource(seededRandom(hash(graph.nodes.map(node => node.id).join('|'))))
    .force('link', forceLink<LayoutNode, LayoutLink>(links)
      .id(node => node.id)
      .distance(linkDistance)
      .strength(linkStrength))
    .force('charge', forceManyBody<LayoutNode>()
      .strength(node => node.kind === 'domain' ? -760 : node.kind === 'subdomain' ? -260 : node.kind === 'tag' ? -92 : -82)
      .distanceMax(1500))
    .force('collide', forceCollide<LayoutNode>()
      .radius(node => nodeRadius(node) * 1.7)
      .strength(0.9))
    .force('x', forceX<LayoutNode>(node => fallback(node).x)
      .strength(node => node.kind === 'domain' ? 1 : node.kind === 'subdomain' ? 0.2 : node.kind === 'knowledge' ? 0.09 : 0.04))
    .force('y', forceY<LayoutNode>(node => fallback(node).y)
      .strength(node => node.kind === 'domain' ? 1 : node.kind === 'subdomain' ? 0.18 : node.kind === 'knowledge' ? 0.08 : 0.035))
    .force('z', forceZ<LayoutNode>(node => fallback(node).z)
      .strength(node => node.kind === 'domain' ? 1 : node.kind === 'subdomain' ? 0.2 : node.kind === 'knowledge' ? 0.09 : 0.04))
    .force('center', forceCenter<LayoutNode>(0, 0, 0))
  simulation.stop()
  simulation.tick(220)

  const byId = new Map(nodes.map(node => [node.id, node]))
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const laidOut = byId.get(node.id)
      return laidOut === undefined ? node : {
        ...node,
        x: laidOut.x,
        y: laidOut.y,
        z: laidOut.z,
      }
    }),
  }
}
