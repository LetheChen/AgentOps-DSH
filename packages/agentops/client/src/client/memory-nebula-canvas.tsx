/**
 * Three.js canvas for the memory nebula.
 *
 * Mirrors the legacy OPS renderer: galactic dust, central core, bloom, orbit
 * camera with auto rotation, wheel zoom, vertical drag inversion and ray-picked
 * stars.
 *
 * @module @agentops/dsh-client/memory-nebula-canvas
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

import {
  alphaFor,
  nodeColor,
  nodeRadius,
  type MemoryGraphEdge,
  type MemoryNebula,
  type NebulaNode,
} from './memory-nebula-model.ts'
import { galaxyDust, layoutNebula } from './memory-nebula-3d.ts'

const RING_COLOR: Record<string, number> = {
  in_progress: 0xf59e0b,
  validating: 0x34d399,
  blocked: 0xf87171,
  closed: 0x10b981,
  proposed: 0xa78bfa,
  implemented: 0x22d3ee,
  rejected: 0x94a3b8,
  archived: 0x818cf8,
}

const LINK_COLOR: Record<string, number> = {
  parent: 0x8b9bb4,
  blocks: 0xf87171,
  related: 0x475569,
  originated_from: 0x5eead4,
  contains: 0x24566a,
  tagged: 0xfbbf24,
}

function linkOpacity(kind: string): number {
  if (kind === 'contains') return 0.2
  if (kind === 'tagged') return 0.12
  if (kind === 'originated_from') return 0.22
  return 0.24
}

interface Props {
  graph: MemoryNebula
  focusId: string | null
  searchSet: ReadonlySet<string> | null
  opacityScale: number
  stress: boolean
  onPick: (node: NebulaNode | null) => void
  onDoubleClick: (node: NebulaNode) => void
  onHover: (node: NebulaNode | null, x: number, y: number) => void
}

function makeGlowTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext('2d')
  if (context === null) return new THREE.Texture(canvas)
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.7)')
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.18)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(canvas)
}

function starShaderMaterial(texture: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: texture },
      uTime: { value: 0 },
      uAlphaScale: { value: 1 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: `
      uniform float uPixelRatio;
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aRingColor;
      varying vec3 vColor;
      varying vec3 vRing;
      varying float vAlpha;
      void main() {
        vColor = color;
        vRing = aRingColor;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * (320.0 / max(1.0, -mv.z)) * uPixelRatio;
      }
    `,
    fragmentShader: `
      uniform sampler2D uTex;
      varying vec3 vColor;
      varying vec3 vRing;
      varying float vAlpha;
      void main() {
        vec4 tex = texture2D(uTex, gl_PointCoord);
        vec3 color = vColor;
        float d = distance(gl_PointCoord, vec2(0.5));
        if (d > 0.62 && d < 0.8 && length(vRing) > 0.01) color = vRing;
        float soft = tex.a * (1.0 - smoothstep(0.0, 0.55, d)) * 0.8 + tex.a * 0.25;
        gl_FragColor = vec4(color, soft * vAlpha * 0.82);
      }
    `,
    transparent: true,
    vertexColors: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
}

function worldPosition(node: NebulaNode): THREE.Vector3 {
  return new THREE.Vector3(node.x, node.y, node.z)
}

function makeLabelSprite(node: NebulaNode, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 96
  const context = canvas.getContext('2d')
  if (context !== null) {
    context.font = `${node.kind === 'domain' ? 30 : 24}px "Segoe UI", sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.shadowColor = 'rgba(2, 6, 23, 0.95)'
    context.shadowBlur = 8
    context.fillStyle = color
    const label = node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title
    context.fillText(label, 256, 48, 480)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: node.kind === 'domain' ? 0.95 : 0.72 })
  const sprite = new THREE.Sprite(material)
  sprite.userData = { texture }
  const scale = node.kind === 'domain' ? 148 : node.kind === 'subdomain' ? 106 : 82
  sprite.scale.set(scale, scale * 0.1875, 1)
  sprite.position.set(node.x, node.y + nodeRadius(node) + 22, node.z)
  return sprite
}

/** Stable fingerprint for scene rebuilds; React object identity is not enough. */
function graphFingerprint(graph: MemoryNebula): string {
  const nodes = graph.nodes.map(node => [
    node.id, node.x, node.y, node.z, node.status, node.timestamp,
    node.title, node.summary, node.tags.join(','), node.importance, node.category, node.kind, node.domainId ?? '', node.subdomain ?? '',
  ].join('\u001f')).join('\u001e')
  const links = graph.links.map(link => [link.source, link.target, link.kind].join('\u001f')).join('\u001e')
  return `${nodes}\u001d${links}`
}

export function MemoryNebulaCanvas({
  graph,
  focusId,
  searchSet,
  opacityScale,
  stress,
  onPick,
  onDoubleClick,
  onHover,
}: Props): ReactElement {
  const mountRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef(focusId)
  const searchRef = useRef(searchSet)
  const opacityRef = useRef(opacityScale)
  const stressRef = useRef(stress)
  const callbacksRef = useRef({ onPick, onDoubleClick, onHover })
  const graphKey = useMemo(() => graphFingerprint(graph), [graph])
  focusRef.current = focusId
  searchRef.current = searchSet
  opacityRef.current = opacityScale
  stressRef.current = stress
  callbacksRef.current = { onPick, onDoubleClick, onHover }

  useEffect(() => {
    const mount = mountRef.current
    if (mount === null) return undefined
    const width = mount.clientWidth || 900
    const height = mount.clientHeight || 600
    const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x050816)
    const camera = new THREE.PerspectiveCamera(52, width / height, 1, 12000)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    const composer = new EffectComposer(renderer)
    composer.setSize(width, height)
    composer.addPass(new RenderPass(scene, camera))
    const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.76, 0.42, 0.2)
    composer.addPass(bloom)

    const group = new THREE.Group()
    scene.add(group)
    const glow = makeGlowTexture()

    // --- galactic dust ---
    const dustGroup = new THREE.Group()
    group.add(dustGroup)
    const dustCount = Math.min(52000, 7800 + graph.nodes.length * 24)
    const dust = galaxyDust(dustCount)
    const dustGeometry = new THREE.BufferGeometry()
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dust.positions, 3))
    dustGeometry.setAttribute('color', new THREE.BufferAttribute(dust.colors, 3))
    const dustPoints = new THREE.Points(dustGeometry, new THREE.PointsMaterial({
      size: 1.9, map: glow, vertexColors: true, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }))
    dustGroup.add(dustPoints)

    const brightDustCount = Math.max(360, Math.round(dustCount * 0.085))
    const brightDust = galaxyDust(brightDustCount, 10_000)
    const brightDustGeometry = new THREE.BufferGeometry()
    brightDustGeometry.setAttribute('position', new THREE.BufferAttribute(brightDust.positions, 3))
    brightDustGeometry.setAttribute('color', new THREE.BufferAttribute(brightDust.colors, 3))
    const brightDustPoints = new THREE.Points(brightDustGeometry, new THREE.PointsMaterial({
      size: 2.8, map: glow, vertexColors: true, transparent: true, opacity: 0.76,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }))
    dustGroup.add(brightDustPoints)

    const nearDustCount = Math.max(240, Math.round(dustCount * 0.04))
    const nearDust = galaxyDust(nearDustCount, 20_000)
    const nearDustGeometry = new THREE.BufferGeometry()
    nearDustGeometry.setAttribute('position', new THREE.BufferAttribute(nearDust.positions, 3))
    nearDustGeometry.setAttribute('color', new THREE.BufferAttribute(nearDust.colors, 3))
    const nearDustPoints = new THREE.Points(nearDustGeometry, new THREE.PointsMaterial({
      size: 3.8, map: glow, vertexColors: true, transparent: true, opacity: 0.34,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }))
    dustGroup.add(nearDustPoints)

    // --- central core ---
    const coreCount = 360
    const corePositions = new Float32Array(coreCount * 3)
    const coreColors = new Float32Array(coreCount * 3)
    const core = (seed: number): number => {
      const value = Math.sin(seed * 17.91) * 10000
      return value - Math.floor(value)
    }
    for (let index = 0; index < coreCount; index++) {
      const angle = core(index + 11) * Math.PI * 2
      const radius = Math.pow(core(index + 12), 1.8) * 110
      corePositions[index * 3] = Math.cos(angle) * radius
      corePositions[index * 3 + 1] = (core(index + 13) + core(index + 14) - 1) * 40
      corePositions[index * 3 + 2] = Math.sin(angle) * radius
      coreColors[index * 3] = 1
      coreColors[index * 3 + 1] = 0.95
      coreColors[index * 3 + 2] = 0.88
    }
    const coreGeometry = new THREE.BufferGeometry()
    coreGeometry.setAttribute('position', new THREE.BufferAttribute(corePositions, 3))
    coreGeometry.setAttribute('color', new THREE.BufferAttribute(coreColors, 3))
    group.add(new THREE.Points(coreGeometry, new THREE.PointsMaterial({
      size: 2.2, map: glow, vertexColors: true, transparent: true, opacity: 0.45,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    })))

    // --- stress rings (additional orbital guides; galaxy stays visible) ---
    const stressGroup = new THREE.Group()
    for (const [radius, tilt] of [[420, 0], [300, 0.31], [480, 0], [340, -0.38]] as const) {
      const ringGeometry = new THREE.RingGeometry(radius - 1, radius + 1, 128)
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: 0x94a3b8, transparent: true, opacity: 0.10, side: THREE.DoubleSide,
      })
      const ringMesh = new THREE.Mesh(ringGeometry, ringMaterial)
      ringMesh.rotation.x = Math.PI / 2 + tilt
      stressGroup.add(ringMesh)
    }
    stressGroup.visible = false
    scene.add(stressGroup)

    // --- links ---
    const links = graph.links
    for (const link of links) {
      const source = graph.nodes.find(node => node.id === link.source)
      const target = graph.nodes.find(node => node.id === link.target)
      if (source === undefined || target === undefined) continue
      const midX = (source.x + target.x) / 2 + (target.z - source.z) * 0.06
      const midZ = (source.z + target.z) / 2 - (target.x - source.x) * 0.06
      const curve = new THREE.QuadraticBezierCurve3(
        worldPosition(source),
        new THREE.Vector3(midX, (source.y + target.y) / 2 + 12, midZ),
        worldPosition(target),
      )
      const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28))
      const material = link.kind === 'tagged' || link.kind === 'related'
        ? new THREE.LineDashedMaterial({
          color: LINK_COLOR[link.kind] ?? 0x475569,
          transparent: true,
          opacity: linkOpacity(link.kind),
          dashSize: 8,
          gapSize: 6,
        })
        : new THREE.LineBasicMaterial({
          color: LINK_COLOR[link.kind] ?? 0x475569,
          transparent: true,
          opacity: linkOpacity(link.kind),
        })
      const line = new THREE.Line(geometry, material)
      if (material instanceof THREE.LineDashedMaterial) line.computeLineDistances()
      group.add(line)
    }

    // --- stars ---
    const visible = graph.nodes
    const positions = new Float32Array(visible.length * 3)
    const colors = new Float32Array(visible.length * 3)
    const sizes = new Float32Array(visible.length)
    const alphas = new Float32Array(visible.length)
    const rings = new Float32Array(visible.length * 3)
    const ringColor = new THREE.Color()
    visible.forEach((node, index) => {
      positions[index * 3] = node.x
      positions[index * 3 + 1] = node.y
      positions[index * 3 + 2] = node.z
      const color = new THREE.Color(nodeColor(node))
      colors[index * 3] = color.r
      colors[index * 3 + 1] = color.g
      colors[index * 3 + 2] = color.b
      sizes[index] = nodeRadius(node) * (node.kind === 'domain' ? 1.85 : node.kind === 'subdomain' ? 1.55 : 1.2)
      alphas[index] = alphaFor(node)
      ringColor.setHex(RING_COLOR[node.status] ?? 0x000000)
      rings[index * 3] = ringColor.r
      rings[index * 3 + 1] = ringColor.g
      rings[index * 3 + 2] = ringColor.b
    })
    const starGeometry = new THREE.BufferGeometry()
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    starGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    starGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1))
    starGeometry.setAttribute('aRingColor', new THREE.BufferAttribute(rings, 3))
    const starMaterial = starShaderMaterial(glow)
    const stars = new THREE.Points(starGeometry, starMaterial)
    stars.userData = { nodes: visible }
    group.add(stars)

    visible
      .filter(node => node.kind !== 'task' && node.kind !== 'memory')
      .forEach((node) => { group.add(makeLabelSprite(node, nodeColor(node))) })

    // --- orbit camera ---
    const orbit = { theta: 0.7, phi: 0.35, dist: Math.max(820, Math.sqrt(Math.max(1, graph.nodes.length)) * 82), auto: true }
    const applyCamera = (): void => {
      camera.position.set(
        orbit.dist * Math.cos(orbit.theta) * Math.cos(orbit.phi),
        orbit.dist * Math.sin(orbit.phi),
        orbit.dist * Math.sin(orbit.theta) * Math.cos(orbit.phi),
      )
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()
    }
    applyCamera()

    // --- picking ---
    const raycaster = new THREE.Raycaster()
    raycaster.params.Points = { threshold: 24 }
    const pointer = new THREE.Vector2()
    const pick = (clientX: number, clientY: number): NebulaNode | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const intersections = raycaster.intersectObject(stars)
      const first = intersections[0]
      if (first === undefined || first.index === undefined) return null
      return visible[first.index] ?? null
    }

    // --- interactions: drag orbit, wheel zoom, vertical drag inversion ---
    let dragging = false
    let moved = false
    let lastX = 0
    let lastY = 0
    let hoverReset = 0
    const element = renderer.domElement
    const down = (event: PointerEvent): void => {
      dragging = true
      moved = false
      lastX = event.clientX
      lastY = event.clientY
      orbit.auto = false
    }
    const move = (event: PointerEvent): void => {
      if (dragging) {
        const dx = event.clientX - lastX
        const dy = event.clientY - lastY
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
        orbit.theta -= dx * 0.005
        orbit.phi = Math.max(-1.2, Math.min(1.35, orbit.phi + dy * 0.004))
        lastX = event.clientX
        lastY = event.clientY
      } else {
        const node = pick(event.clientX, event.clientY)
        if (node !== null) callbacksRef.current.onHover(node, event.clientX, event.clientY)
        else if (Date.now() - hoverReset > 120) { callbacksRef.current.onHover(null, 0, 0); hoverReset = Date.now() }
        element.style.cursor = node === null ? 'grab' : 'pointer'
      }
    }
    const up = (event: PointerEvent): void => {
      dragging = false
      window.setTimeout(() => { orbit.auto = true }, 4000)
      if (!moved) callbacksRef.current.onPick(pick(event.clientX, event.clientY))
    }
    const double = (event: MouseEvent): void => {
      const node = pick(event.clientX, event.clientY)
      if (node !== null) callbacksRef.current.onDoubleClick(node)
    }
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      orbit.dist = Math.max(260, Math.min(4200, orbit.dist * (event.deltaY > 0 ? 1.1 : 0.9)))
    }
    element.addEventListener('pointerdown', down)
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('dblclick', double)
    element.addEventListener('wheel', wheel, { passive: false })
    element.style.cursor = 'grab'

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      const nextWidth = Math.max(1, Math.floor(entry.contentRect.width))
      const nextHeight = Math.max(1, Math.floor(entry.contentRect.height))
      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()
      renderer.setSize(nextWidth, nextHeight, false)
      composer.setSize(nextWidth, nextHeight)
      bloom.resolution.set(nextWidth, nextHeight)
    })
    resizeObserver.observe(mount)

    let frame = 0
    let last = 0
    const targetFrameTime = reduced ? 50 : 33
    const alphaAttribute = starGeometry.getAttribute('aAlpha') as THREE.BufferAttribute
    let focusApplied: string | null | undefined = undefined
    let searchApplied: ReadonlySet<string> | null | undefined = undefined
    const focusNeighbours = new Set<string>()
    const loop = (time: number): void => {
      frame = requestAnimationFrame(loop)
      if (time - last < targetFrameTime) return
      last = time
      if (orbit.auto && !reduced) orbit.theta += 0.0012
      if (!reduced) dustGroup.rotation.y += 0.00006
      applyCamera()
      const timeUniform = starMaterial.uniforms.uTime
      const alphaUniform = starMaterial.uniforms.uAlphaScale
      if (timeUniform !== undefined) timeUniform.value = time
      if (alphaUniform !== undefined) alphaUniform.value = opacityRef.current
      const search = searchRef.current
      if (focusRef.current !== focusApplied || search !== searchApplied) {
        focusApplied = focusRef.current
        searchApplied = search
        focusNeighbours.clear()
        if (focusApplied !== null) {
          focusNeighbours.add(focusApplied)
          for (const link of links) {
            if (link.source === focusApplied) focusNeighbours.add(link.target)
            if (link.target === focusApplied) focusNeighbours.add(link.source)
          }
        }
        visible.forEach((node, index) => {
          let alpha = alphaFor(node)
          if (search !== null && !search.has(node.id)) alpha *= 0.12
          if (focusApplied !== null) alpha = focusNeighbours.has(node.id) ? alpha : alpha * 0.18
          alphaAttribute.setX(index, alpha)
        })
        alphaAttribute.needsUpdate = true
      }
      stressGroup.visible = stressRef.current
      composer.render()
    }
    frame = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('dblclick', double)
      element.removeEventListener('wheel', wheel)
      scene.traverse((object) => {
        const mesh = object as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }
        const texture = (object.userData as { texture?: THREE.Texture }).texture
        texture?.dispose()
        mesh.geometry?.dispose()
        if (Array.isArray(mesh.material)) mesh.material.forEach((material) =>{  material.dispose() })
        else mesh.material?.dispose()
      })
      composer.dispose()
      renderer.dispose()
      glow.dispose()
      mount.removeChild(element)
    }
  }, [graphKey])

  return <div ref={mountRef} className="mn-three" />
}

/** Exported for tests that need the stable layout primitive. */
export { layoutNebula }
export type { MemoryGraphEdge }
