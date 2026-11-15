// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { WorkflowDagCanvas } from '../src/client/workflow-dag-canvas.js'

afterEach(cleanup)

const NODES = [
  { id: 'scan', level: 0 },
  { id: 'analyze', level: 1 },
]

describe('workflow DAG canvas', () => {
  it('zooms within bounds, resets, and fits the viewport', () => {
    const labels = {
      controlsAria: 'Canvas zoom',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fit: 'Fit to canvas',
      reset: 'Reset zoom',
      value: (percent: number) => `${percent}%`,
    }
    const { container, getByRole } = render(
      <WorkflowDagCanvas
        workflowId="zoom"
        nodes={NODES}
        edges={[]}
        emptyText="empty"
        tooManyText="large"
        ariaLabel="zoom graph"
        layerLabel={level => `Level ${level}`}
        zoomLabels={labels}
      />,
    )
    const viewport = container.querySelector<HTMLDivElement>('.dag-canvas-scroll')
    expect(viewport).not.toBeNull()
    if (viewport === null) return
    const scrollTo = vi.fn()
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 1 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 1 })
    Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo })

    expect(getByRole('group', { name: labels.controlsAria })).toBeDefined()
    const zoomIn = getByRole('button', { name: labels.zoomIn })
    const zoomOut = getByRole('button', { name: labels.zoomOut })
    expect(viewport.dataset.zoom).toBe('100')

    fireEvent.click(zoomIn)
    expect(viewport.dataset.zoom).toBe('125')
    fireEvent.click(zoomIn)
    fireEvent.click(zoomIn)
    fireEvent.click(zoomIn)
    expect(viewport.dataset.zoom).toBe('200')
    expect(zoomIn.hasAttribute('disabled')).toBe(true)

    fireEvent.click(getByRole('button', { name: labels.reset }))
    expect(viewport.dataset.zoom).toBe('100')
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 })
    fireEvent.click(zoomOut)
    fireEvent.click(zoomOut)
    fireEvent.click(zoomOut)
    expect(viewport.dataset.zoom).toBe('25')
    expect(zoomOut.hasAttribute('disabled')).toBe(true)

    fireEvent.click(getByRole('button', { name: labels.reset }))
    fireEvent.click(getByRole('button', { name: labels.fit }))
    expect(viewport.dataset.zoom).toBe('25')
  })

  it('renders caller-provided empty and oversized notices', () => {
    const empty = render(
      <WorkflowDagCanvas
        workflowId="empty"
        nodes={[]}
        edges={[]}
        emptyText="no graph"
        tooManyText="too big"
        ariaLabel="empty graph"
        layerLabel={level => `Level ${level}`}
      />,
    )
    expect(empty.getByText('no graph')).toBeDefined()
    empty.unmount()

    const tooMany = render(
      <WorkflowDagCanvas
        workflowId="large"
        nodes={Array.from({ length: 201 }, (_, index) => ({ id: `n${index}`, level: 0 }))}
        edges={[]}
        emptyText="no graph"
        tooManyText="too big"
        ariaLabel="large graph"
        layerLabel={level => `Level ${level}`}
      />,
    )
    expect(tooMany.getByText('too big')).toBeDefined()
  })

  it('uses the supplied accessible name and highlights requested nodes', () => {
    const { container } = render(
      <WorkflowDagCanvas
        workflowId="log-patrol"
        nodes={NODES}
        edges={[{ from: 'scan', to: 'analyze' }]}
        highlightedNodeIds={new Set(['analyze'])}
        emptyText="no graph"
        tooManyText="too big"
        ariaLabel="log patrol graph"
        layerLabel={level => `Level ${level}`}
      />,
    )

    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('role')).toBe('img')
    expect(svg?.getAttribute('aria-label')).toBe('log patrol graph')
    const groups = [...container.querySelectorAll<SVGGElement>('.dag-canvas-node')]
    expect(groups).toHaveLength(2)
    expect(groups.find(group => group.textContent?.includes('scan'))?.classList.contains('dag-canvas-node-highlighted')).toBe(false)
    const highlighted = groups.find(group => group.textContent?.includes('analyze'))
    expect(highlighted?.classList.contains('dag-canvas-node-highlighted')).toBe(true)
    expect(highlighted?.querySelector('rect')?.getAttribute('stroke-width')).toBe('2.5')
  })

  it('gives each rendered canvas a distinct arrow marker id', () => {
    const { container } = render(
      <>
        <WorkflowDagCanvas workflowId="one" nodes={NODES} edges={[]} emptyText="empty" tooManyText="large" ariaLabel="one" layerLabel={level => `Level ${level}`} />
        <WorkflowDagCanvas workflowId="two" nodes={NODES} edges={[]} emptyText="empty" tooManyText="large" ariaLabel="two" layerLabel={level => `Level ${level}`} />
      </>,
    )
    const ids = [...container.querySelectorAll('marker')].map(marker => marker.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('styles schedule edges solid, data edges dashed, and labels data ports', () => {
    const { container } = render(
      <WorkflowDagCanvas
        workflowId="two-domains"
        nodes={NODES}
        edges={[
          { from: 'scan', to: 'analyze', domain: 'schedule' },
          { from: 'scan', to: 'analyze', domain: 'data', port: 'records' },
        ]}
        emptyText="empty"
        tooManyText="large"
        ariaLabel="two domains"
        layerLabel={level => `Level ${level}`}
      />,
    )

    const schedule = container.querySelector('.dag-canvas-edge-schedule')
    const data = container.querySelector('.dag-canvas-edge-data')
    expect(schedule?.getAttribute('stroke-dasharray')).toBeNull()
    expect(data?.getAttribute('stroke-dasharray')).toBe('5 4')
    expect(container.querySelectorAll('.dag-canvas-edge')).toHaveLength(2)
    expect(container.querySelector('.dag-canvas-edge-port')?.textContent).toBe('records')
  })

  it('keeps every edge pointer-selectable and exposes its data port through keyboard selection', () => {
    const onEdgeSelect = vi.fn()
    const edgeAriaLabel = vi.fn((edge: { domain: 'schedule' | 'data'; from: string; to: string; port?: string }) =>
      edge.domain === 'data' ? `Data ${edge.from} to ${edge.to} port ${edge.port}` : `Schedule ${edge.from} to ${edge.to}`)
    const { container, getByRole } = render(
      <WorkflowDagCanvas
        workflowId="editable-edges"
        nodes={NODES}
        edges={[
          { from: 'scan', to: 'analyze', domain: 'schedule', port: 'ignored' },
          { from: 'scan', to: 'analyze', domain: 'data', port: 'records' },
        ]}
        emptyText="empty"
        tooManyText="large"
        ariaLabel="editable edges"
        layerLabel={level => `Level ${level}`}
        editable
        selectedEdge={{ domain: 'data', from: 'scan', to: 'analyze', port: 'records' }}
        onEdgeSelect={onEdgeSelect}
        edgeAriaLabel={edgeAriaLabel}
      />,
    )

    expect(container.querySelectorAll('.dag-canvas-edge-hit')).toHaveLength(2)
    const schedule = getByRole('button', { name: 'Schedule scan to analyze' })
    const data = getByRole('button', { name: 'Data scan to analyze port records' })
    expect(schedule.getAttribute('aria-pressed')).toBe('false')
    expect(data.getAttribute('aria-pressed')).toBe('true')
    expect(data.classList.contains('is-selected')).toBe(true)

    fireEvent.click(schedule)
    expect(onEdgeSelect).toHaveBeenLastCalledWith({ domain: 'schedule', from: 'scan', to: 'analyze' })
    fireEvent.keyDown(data, { key: 'Enter' })
    expect(onEdgeSelect).toHaveBeenLastCalledWith({
      domain: 'data',
      from: 'scan',
      to: 'analyze',
      port: 'records',
    })
    expect(edgeAriaLabel).toHaveBeenCalledWith({ domain: 'schedule', from: 'scan', to: 'analyze' })
    expect(edgeAriaLabel).toHaveBeenCalledWith({
      domain: 'data',
      from: 'scan',
      to: 'analyze',
      port: 'records',
    })
  })

  it('keeps the data port label inside the SVG viewBox', () => {
    const { container } = render(
      <WorkflowDagCanvas
        workflowId="ports"
        nodes={NODES}
        edges={[{ from: 'scan', to: 'analyze', domain: 'data', port: 'records' }]}
        emptyText="empty"
        tooManyText="large"
        ariaLabel="ports"
        layerLabel={level => `Level ${level}`}
      />,
    )

    const svg = container.querySelector('svg')
    const label = container.querySelector('.dag-canvas-edge-port')
    const width = Number(svg?.getAttribute('width'))
    const height = Number(svg?.getAttribute('height'))
    const x = Number(label?.getAttribute('x'))
    const y = Number(label?.getAttribute('y'))
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(width)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(y).toBeLessThanOrEqual(height)
  })

  it('makes nodes keyboard-selectable in edit mode without an image role', () => {
    const onNodeSelect = vi.fn()
    const { container, getByRole } = render(
      <WorkflowDagCanvas
        workflowId="editable"
        nodes={NODES}
        edges={[]}
        emptyText="empty"
        tooManyText="large"
        ariaLabel="editable graph"
        layerLabel={level => `Level ${level}`}
        editable
        selectedNodeId="scan"
        onNodeSelect={onNodeSelect}
        nodeAriaLabel={id => `Select ${id}`}
      />,
    )

    expect(container.querySelector('svg')?.getAttribute('role')).toBe('group')
    const scan = getByRole('button', { name: 'Select scan' })
    fireEvent.click(scan)
    expect(onNodeSelect).toHaveBeenCalledWith('scan')
    fireEvent.keyDown(scan, { key: 'Enter' })
    fireEvent.keyDown(scan, { key: ' ' })
    expect(onNodeSelect).toHaveBeenCalledTimes(3)
    expect(scan.classList.contains('dag-canvas-node-selected')).toBe(true)
    const rect = scan.querySelector('rect')
    expect(rect?.getAttribute('fill')).toBe('var(--color-primary-tint)')
    expect(rect?.getAttribute('stroke')).toBe('var(--color-primary)')
  })
  it('lets a read-only collaboration viewer select nodes and edges', () => {
    const onNodeSelect = vi.fn()
    const onEdgeSelect = vi.fn()
    const { container, getByRole } = render(
      <WorkflowDagCanvas
        workflowId="selectable"
        nodes={NODES}
        edges={[{ from: 'scan', to: 'analyze', domain: 'schedule' }]}
        emptyText="empty"
        tooManyText="large"
        ariaLabel="selectable graph"
        layerLabel={level => `Level ${level}`}
        selectable
        selectedNodeId="scan"
        onNodeSelect={onNodeSelect}
        onEdgeSelect={onEdgeSelect}
        nodeAriaLabel={id => `Select ${id}`}
        edgeAriaLabel={edge => `Select ${edge.from} to ${edge.to}`}
      />,
    )

    expect(container.querySelector('svg')?.getAttribute('role')).toBe('group')
    const scan = getByRole('button', { name: 'Select scan' })
    const edge = getByRole('button', { name: 'Select scan to analyze' })
    expect(scan.getAttribute('aria-pressed')).toBe('true')
    expect(edge.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(scan)
    fireEvent.keyDown(edge, { key: ' ' })
    expect(onNodeSelect).toHaveBeenCalledWith('scan')
    expect(onEdgeSelect).toHaveBeenCalledWith({ domain: 'schedule', from: 'scan', to: 'analyze' })
  })
})
