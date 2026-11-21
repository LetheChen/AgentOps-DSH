declare module 'd3-force-3d' {
  export interface SimulationNodeDatum {
    index?: number
    x?: number
    y?: number
    z?: number
    vx?: number
    vy?: number
    vz?: number
    fx?: number | null
    fy?: number | null
    fz?: number | null
  }

  export interface SimulationLinkDatum<NodeDatum extends SimulationNodeDatum> {
    source: string | number | NodeDatum
    target: string | number | NodeDatum
    index?: number
  }

  export interface Force<NodeDatum extends SimulationNodeDatum, LinkDatum extends SimulationLinkDatum<NodeDatum>> {
    (alpha: number): void
    initialize?(nodes: NodeDatum[], random: () => number, numDimensions: number): void
  }

  export interface ForceLink<
    NodeDatum extends SimulationNodeDatum,
    LinkDatum extends SimulationLinkDatum<NodeDatum>,
  > extends Force<NodeDatum, LinkDatum> {
    id(accessor: (node: NodeDatum, index: number, nodes: NodeDatum[]) => string | number): this
    distance(accessor: number | ((link: LinkDatum, index: number, links: LinkDatum[]) => number)): this
    strength(accessor: number | ((link: LinkDatum, index: number, links: LinkDatum[]) => number)): this
    links(links: LinkDatum[]): this
  }

  export interface ForceManyBody<NodeDatum extends SimulationNodeDatum> extends Force<NodeDatum, SimulationLinkDatum<NodeDatum>> {
    strength(accessor: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number)): this
    distanceMax(distance: number): this
  }

  export interface ForceCollide<NodeDatum extends SimulationNodeDatum> extends Force<NodeDatum, SimulationLinkDatum<NodeDatum>> {
    radius(accessor: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number)): this
    strength(strength: number): this
  }

  export interface ForceAxis<NodeDatum extends SimulationNodeDatum> extends Force<NodeDatum, SimulationLinkDatum<NodeDatum>> {
    x(accessor: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number)): this
    strength(accessor: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number)): this
  }

  export interface ForceCenter<NodeDatum extends SimulationNodeDatum> extends Force<NodeDatum, SimulationLinkDatum<NodeDatum>> {
    x(value: number): this
    y(value: number): this
    z(value: number): this
  }

  export interface Simulation<NodeDatum extends SimulationNodeDatum, LinkDatum extends SimulationLinkDatum<NodeDatum>> {
    tick(iterations?: number): this
    stop(): this
    restart(): this
    alpha(): number
    alpha(value: number): this
    alphaMin(value: number): this
    alphaDecay(value: number): this
    velocityDecay(value: number): this
    randomSource(random: () => number): this
    force(name: string): Force<NodeDatum, LinkDatum> | undefined
    force(name: string, force: Force<NodeDatum, LinkDatum> | null): this
  }

  export function forceSimulation<NodeDatum extends SimulationNodeDatum>(
    nodes?: NodeDatum[],
    numDimensions?: number,
  ): Simulation<NodeDatum, SimulationLinkDatum<NodeDatum>>
  export function forceLink<NodeDatum extends SimulationNodeDatum, LinkDatum extends SimulationLinkDatum<NodeDatum>>(
    links?: LinkDatum[],
  ): ForceLink<NodeDatum, LinkDatum>
  export function forceManyBody<NodeDatum extends SimulationNodeDatum>(): ForceManyBody<NodeDatum>
  export function forceCollide<NodeDatum extends SimulationNodeDatum>(): ForceCollide<NodeDatum>
  export function forceCenter<NodeDatum extends SimulationNodeDatum>(x?: number, y?: number, z?: number): ForceCenter<NodeDatum>
  export function forceX<NodeDatum extends SimulationNodeDatum>(
    x?: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number),
  ): ForceAxis<NodeDatum>
  export function forceY<NodeDatum extends SimulationNodeDatum>(
    y?: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number),
  ): ForceAxis<NodeDatum>
  export function forceZ<NodeDatum extends SimulationNodeDatum>(
    z?: number | ((node: NodeDatum, index: number, nodes: NodeDatum[]) => number),
  ): ForceAxis<NodeDatum>
}
