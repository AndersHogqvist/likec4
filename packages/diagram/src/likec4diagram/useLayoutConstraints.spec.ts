import { BBox } from '@likec4/core/geometry'
import type { NonEmptyArray, Point } from '@likec4/core/types'
import { describe, expect, it, vi } from 'vitest'
import { selectLabelRoutes } from '../hooks/useEdgeTracks'
import type { XYStoreApi } from '../hooks/useXYFlow'
import { editedEdgePath, layoutedEdgePath } from '../utils/edge-path'
import type { Types } from './types'
import { createLayoutConstraints } from './useLayoutConstraints'

type MockNode = { id: string; parentId?: string; x: number; y: number; width: number; height: number }
type MockEdge = {
  id: string
  source: string
  target: string
  data: { points: [number, number][]; controlPoints: null; labelBBox: null }
}

/** a minimal xyflow store with leaf nodes only */
function fakeStore(
  nodes: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  edges: Array<
    Pick<Types.RelationshipEdge, 'id' | 'source' | 'target'> & { data: Partial<Types.RelationshipEdge['data']> }
  >,
) {
  const nodeLookup = new Map(nodes.map(n => [n.id, {
    id: n.id,
    type: 'element',
    position: { x: n.x, y: n.y },
    measured: { width: n.width, height: n.height },
    internals: { positionAbsolute: { x: n.x, y: n.y } },
    data: {},
  }]))
  const edgeLookup = new Map(edges.map(e => [e.id, { ...e, type: 'relationship' }]))
  const triggerEdgeChanges = vi.fn<(changes: Array<{ id: string; item: Types.RelationshipEdge }>) => void>(
    (changes) => {
      for (const change of changes) {
        edgeLookup.set(change.id, change.item)
      }
      state.edges = [...edgeLookup.values()]
    },
  )
  const state = {
    nodeLookup,
    nodes: [...nodeLookup.values()],
    parentLookup: new Map(),
    edges: [...edgeLookup.values()],
    edgeLookup,
    triggerNodeChanges: vi.fn<(changes: unknown[]) => void>(),
    triggerEdgeChanges,
  }
  const api = { getState: () => state } as unknown as XYStoreApi
  return {
    api,
    moveNode: (id: string, x: number, y: number) => {
      const node = nodeLookup.get(id)!
      node.position = { x, y }
      node.internals.positionAbsolute = { x, y }
    },
    edgeAfterDrag: (id: string) => {
      const changes = triggerEdgeChanges.mock.calls.at(-1)![0]
      return changes.find(c => c.id === id)!.item
    },
  }
}

// a vertical route from `a` down to `b`, with `c` sitting to the right of where the route lands after `b` moves right
const a = { id: 'a', x: 0, y: 0, width: 100, height: 60 }
const b = { id: 'b', x: 0, y: 300, width: 100, height: 60 }
const c = { id: 'c', x: 130, y: 100, width: 100, height: 60 }
const edge = (isLabelCustomized: boolean) => ({
  id: 'a-b',
  source: 'a',
  target: 'b',
  data: {
    points: [[50, 60], [50, 140], [50, 220], [50, 300]] as NonEmptyArray<Point>,
    controlPoints: null,
    labelBBox: { x: 54, y: 172, width: 40, height: 16 },
    isLabelCustomized,
    dir: 'forward' as const,
  },
})

describe('createLayoutConstraints under ortho routing', () => {
  it('places an auto-placed label on the new route, clear of every leaf node, when a node moves', () => {
    const store = fakeStore([a, b, c], [edge(false)])
    const solver = createLayoutConstraints(store.api, ['b'], 'ortho')
    store.moveNode('b', 200, 300)
    solver.flushPending()
    const { labelBBox, controlPoints } = store.edgeAfterDrag('a-b').data
    expect(controlPoints).not.toBeNull()
    expect(labelBBox).toMatchObject({ width: 40, height: 16 })
    for (const node of [a, b, c]) {
      expect(BBox.intersects(labelBBox!, node), `label off ${node.id}`).toBe(false)
    }
    // beside the route, not carried along with the old geometry: the old box shifted by the drag would sit on `c`
    expect(labelBBox).not.toEqual({ x: 54 + 200, y: 172, width: 40, height: 16 })
  })

  it('keeps carrying a label the user moved by hand', () => {
    const custom = fakeStore([a, b, c], [edge(true)])
    const solver = createLayoutConstraints(custom.api, ['b'], 'ortho')
    custom.moveNode('b', 200, 300)
    solver.flushPending()
    const placed = custom.edgeAfterDrag('a-b').data.labelBBox!
    // translated relative to the moving end, not re-placed: it keeps its height offset along the route
    expect(placed.width).toBe(40)
    expect(placed.y).toBe(172)
    expect(placed.x).toBeGreaterThan(54)
  })

  it('places all moved labels against the final tracks while preserving a hand-moved label', () => {
    const fixedLabel = { x: 60, y: 109, width: 40, height: 16 }
    const edges = [
      { ...edge(false), id: 'auto-1' },
      { ...edge(false), id: 'auto-2' },
      {
        id: 'manual',
        source: 'd',
        target: 'e',
        data: {
          ...edge(true).data,
          points: [[450, 60], [450, 140], [450, 220], [450, 300]] satisfies NonEmptyArray<Point>,
          labelBBox: fixedLabel,
        },
      },
    ]
    const store = fakeStore([a, b, c, { ...a, id: 'd', x: 400 }, { ...b, id: 'e', x: 400 }], edges)
    const solver = createLayoutConstraints(store.api, ['b'], 'ortho')
    store.moveNode('b', 200, 300)
    solver.flushPending()

    const routes = selectLabelRoutes(store.api.getState())
    const manual = routes.find(route => route.id === 'manual')!.labelBBox!
    expect(manual).toEqual(fixedLabel)
    for (const route of routes.filter(route => route.id !== 'manual')) {
      const label = route.labelBBox!
      for (const other of routes.filter(other => other.id !== route.id)) {
        expect(BBox.intersects(label, other.labelBBox!), `${route.id} clear of ${other.id}`).toBe(false)
      }
      for (const other of routes) {
        for (const [from, to] of other.segments) {
          const line = BBox.fromPoints([[from.x, from.y], [to.x, to.y]])
          expect(
            BBox.intersects(label, BBox.expand(line, 1)),
            `${route.id} clear of track ${other.id}`,
          ).toBe(false)
        }
      }
    }
  })

  it('restores the original labels when a drag returns to its starting position', () => {
    const original = edge(false)
    const store = fakeStore([a, b], [original])
    const solver = createLayoutConstraints(store.api, ['b'], 'ortho')
    store.moveNode('b', 200, 300)
    solver.flushPending()
    store.moveNode('b', 0, 300)
    solver.flushPending()
    expect(store.edgeAfterDrag('a-b').data.labelBBox).toEqual(original.data.labelBBox)
  })

  it('leaves spline label interpolation unchanged', () => {
    const store = fakeStore([a, b, c], [edge(false)])
    const solver = createLayoutConstraints(store.api, ['b'], 'spline')
    store.moveNode('b', 200, 300)
    solver.flushPending()
    expect(store.edgeAfterDrag('a-b').data.labelBBox).toEqual({ x: 148, y: 172, width: 40, height: 16 })
  })
})

/** A minimal XYFlow store for resize tests, including parent-child relationships and change spies. */
function mockStore(nodes: MockNode[], edges: MockEdge[] = []) {
  const nodeLookup = new Map(nodes.map(n => [n.id, {
    id: n.id,
    parentId: n.parentId,
    position: { x: n.x, y: n.y },
    width: n.width,
    height: n.height,
    internals: { positionAbsolute: { x: n.x, y: n.y } },
  }]))
  const parentLookup = new Map<string, Map<string, unknown>>()
  for (const node of nodeLookup.values()) {
    if (node.parentId) {
      const children = parentLookup.get(node.parentId) ?? new Map()
      children.set(node.id, node)
      parentLookup.set(node.parentId, children)
    }
  }
  const triggerNodeChanges = vi.fn<(changes: unknown[]) => void>()
  const triggerEdgeChanges = vi.fn<(changes: unknown[]) => void>()
  const state = {
    nodeLookup,
    parentLookup,
    edges,
    edgeLookup: new Map(edges.map(edge => [edge.id, edge])),
    triggerNodeChanges,
    triggerEdgeChanges,
  }
  // oxlint-disable-next-line no-unsafe-type-assertion
  const store = { getState: () => state } as unknown as XYStoreApi
  return { store, triggerNodeChanges, triggerEdgeChanges }
}

describe('createLayoutConstraints.resize', () => {
  it('resizes leaf nodes and emits dimension changes', () => {
    const { store, triggerNodeChanges } = mockStore([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 200, y: 0, width: 300, height: 80 },
    ])
    const constraints = createLayoutConstraints(store, ['a', 'b'], 'spline')
    constraints.resize('b', { width: 100 })
    constraints.updateXYFlow()

    expect(triggerNodeChanges).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'b', type: 'dimensions', dimensions: { width: 100, height: 80 } }),
    ]))
  })

  it('does not shrink compound nodes below their children', () => {
    const { store } = mockStore([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'compound', x: 200, y: 0, width: 400, height: 300 },
      { id: 'child', parentId: 'compound', x: 50, y: 60, width: 200, height: 100 },
    ])
    const constraints = createLayoutConstraints(store, ['a', 'compound'], 'spline')
    constraints.resize('compound', { width: 100, height: 50 })

    expect(constraints.rects.get('compound')?.dimensions).toEqual({ width: 50 + 200 + 42, height: 60 + 100 + 42 })
  })

  it('keeps control points null for a two-point edge when both endpoints resize', () => {
    const edge: MockEdge = {
      id: 'a-b',
      source: 'a',
      target: 'b',
      data: { points: [[100, 25], [200, 25]], controlPoints: null, labelBBox: null },
    }
    const { store, triggerEdgeChanges } = mockStore([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 200, y: 0, width: 100, height: 50 },
    ], [edge])
    const constraints = createLayoutConstraints(store, ['a', 'b'], 'spline')
    constraints.resize('a', { width: 120 })
    constraints.updateXYFlow()

    expect(triggerEdgeChanges).not.toHaveBeenCalled()
  })

  it('keeps control points null for a two-point edge when one endpoint moves', () => {
    const edge: MockEdge = {
      id: 'a-b',
      source: 'a',
      target: 'b',
      data: { points: [[100, 25], [200, 25]], controlPoints: null, labelBBox: null },
    }
    const { store, triggerEdgeChanges } = mockStore([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 200, y: 0, width: 100, height: 50 },
    ], [edge])
    const constraints = createLayoutConstraints(store, ['a', 'b'], 'spline')
    constraints.rects.get('a')!.positionAbsolute = { x: 20, y: 0 }
    constraints.updateXYFlow()

    expect(triggerEdgeChanges).toHaveBeenCalledWith([
      expect.objectContaining({
        item: expect.objectContaining({ data: expect.objectContaining({ controlPoints: null }) }),
      }),
    ])
  })
})

describe('createLayoutConstraints with connected nodes', () => {
  it('keeps an orthogonal detour attached after alignment', () => {
    const source = { id: 'a', x: 0, y: 200, width: 100, height: 60 }
    const target = { id: 'b', x: 300, y: 0, width: 100, height: 60 }
    const obstacle = { id: 'c', x: 150, y: 0, width: 100, height: 100 }
    const store = fakeStore([source, target, obstacle], [{
      id: 'a-b',
      source: 'a',
      target: 'b',
      data: {
        points: [
          [50, 200],
          [50, 150],
          [50, 100],
          [50, 50],
          [130, 50],
          [210, 50],
          [300, 50],
        ] satisfies NonEmptyArray<Point>,
        controlPoints: null,
        labelBBox: null,
        dir: 'forward',
      },
    }])
    const constraints = createLayoutConstraints(store.api, ['a', 'b'], 'ortho')

    store.moveNode('a', 0, 0)
    constraints.rects.get('a')!.positionAbsolute = { x: 0, y: 0 }
    constraints.updateXYFlow()

    const updated = store.edgeAfterDrag('a-b').data
    const path = layoutedEdgePath({
      source: { center: { x: 50, y: 30 }, node: { ...source, y: 0 } },
      target: { center: { x: 350, y: 30 }, node: target },
      points: updated.points,
      routing: 'ortho',
    })
    expect(updated.controlPoints).toBeNull()
    expect(path.segments[0]?.[0]).toEqual({ x: 50, y: -2 })
    expect(path.segments.at(-1)?.[1]).toEqual({ x: 350, y: -2 })
    expect(path.segments.every(([a, b]) => a.x === b.x || a.y === b.y)).toBe(true)
    expect(path.segments.every(([a, b]) =>
      !BBox.intersects(
        BBox.expand(
          BBox.fromPoints([
            [a.x, a.y],
            [b.x, b.y],
          ]),
          1,
        ),
        obstacle,
      )
    )).toBe(true)
  })

  it('keeps an existing detour clear of another node after alignment', () => {
    const source = { id: 'a', x: 0, y: 200, width: 100, height: 60 }
    const target = { id: 'b', x: 400, y: 0, width: 100, height: 60 }
    const obstacle = { id: 'c', x: 200, y: 0, width: 100, height: 120 }
    const store = fakeStore([source, target, obstacle], [{
      id: 'a-b',
      source: 'a',
      target: 'b',
      data: {
        points: [
          [80, 200],
          [130, 150],
          [180, -80],
          [250, -80],
          [320, -80],
          [370, 20],
          [420, 60],
        ] satisfies NonEmptyArray<Point>,
        controlPoints: null,
        labelBBox: { x: 230, y: -90, width: 40, height: 16 },
        dir: 'forward',
      },
    }])
    const constraints = createLayoutConstraints(store.api, ['a', 'b'], 'spline')

    store.moveNode('a', 0, 0)
    constraints.rects.get('a')!.positionAbsolute = { x: 0, y: 0 }
    constraints.updateXYFlow()

    const updated = store.edgeAfterDrag('a-b').data
    expect(updated.controlPoints).toBeNull()
    expect(updated.points[0]).toEqual([106, 30])
    expect(updated.points.at(-1)).toEqual([394, 30])
    expect(updated.points[3]![1]).toBeLessThan(obstacle.y)
    expect(Math.abs(updated.labelBBox!.y + 8 - updated.points[3]![1])).toBeLessThan(20)
  })

  it('reanchors an unedited edge to the facing sides after selected nodes align', () => {
    const source = { id: 'a', x: 0, y: 200, width: 100, height: 60 }
    const target = { id: 'b', x: 300, y: 0, width: 100, height: 60 }
    const store = fakeStore([source, target], [{
      id: 'a-b',
      source: 'a',
      target: 'b',
      data: {
        points: [[80, 200], [130, 150], [250, 90], [320, 60]] satisfies NonEmptyArray<Point>,
        controlPoints: null,
        labelBBox: { x: 180, y: 120, width: 40, height: 16 },
        dir: 'forward',
      },
    }])
    const constraints = createLayoutConstraints(store.api, ['a', 'b'], 'spline')

    store.moveNode('a', 0, 0)
    constraints.rects.get('a')!.positionAbsolute = { x: 0, y: 0 }
    constraints.updateXYFlow()

    const updated = store.edgeAfterDrag('a-b').data
    const endpoints = {
      source: { center: { x: 50, y: 30 }, node: { x: 0, y: 0, width: 100, height: 60 } },
      target: { center: { x: 350, y: 30 }, node: target },
    }
    const path = updated.controlPoints
      ? editedEdgePath({ ...endpoints, controlPoints: updated.controlPoints, routing: 'spline' })
      : layoutedEdgePath({ ...endpoints, points: updated.points, routing: 'spline' })

    expect(path.d).toMatch(/^M\s*106,\d+/)
    expect(path.d).toMatch(/294,\d+$/)
    expect(updated.points.every(([, y]) => y === 30)).toBe(true)
    expect(updated.labelBBox).toMatchObject({ y: 22 })
  })

  it('moves each end of the edge with its node when selected nodes move by different amounts', () => {
    const edge: MockEdge = {
      id: 'a-b',
      source: 'a',
      target: 'b',
      data: {
        points: [[100, 25], [130, 25], [170, 225], [200, 225]],
        controlPoints: null,
        labelBBox: null,
      },
    }
    const { store, triggerEdgeChanges } = mockStore([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 200, y: 200, width: 100, height: 50 },
    ], [edge])
    const constraints = createLayoutConstraints(store, ['a', 'b'], 'spline')

    constraints.rects.get('b')!.positionAbsolute = { x: 200, y: 0 }
    constraints.updateXYFlow()

    const changes = triggerEdgeChanges.mock.lastCall?.[0]
    expect(changes).toHaveLength(1)
    expect(changes?.[0]).toHaveProperty('item.data.points.0', [100, 25])
    expect(changes?.[0]).toHaveProperty('item.data.points.3', [200, 25])
  })

  it('keeps the target end in place when only the selected source moves', () => {
    const edge: MockEdge = {
      id: 'a-b',
      source: 'a',
      target: 'b',
      data: { points: [[100, 25], [130, 25], [170, 225], [200, 225]], controlPoints: null, labelBBox: null },
    }
    const { store, triggerEdgeChanges } = mockStore([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 200, y: 200, width: 100, height: 50 },
    ], [edge])
    const constraints = createLayoutConstraints(store, ['a', 'b'], 'spline')

    constraints.rects.get('a')!.positionAbsolute = { x: 40, y: 0 }
    constraints.updateXYFlow()

    const changes = triggerEdgeChanges.mock.lastCall?.[0]
    expect(changes).toHaveLength(1)
    expect(changes?.[0]).toHaveProperty('item.data.points.0', [140, 25])
    expect(changes?.[0]).toHaveProperty('item.data.points.3', [200, 225])
  })

  it('translates the full edge when both selected nodes move together', () => {
    const edge: MockEdge = {
      id: 'a-b',
      source: 'a',
      target: 'b',
      data: { points: [[100, 25], [130, 25], [170, 225], [200, 225]], controlPoints: null, labelBBox: null },
    }
    const { store, triggerEdgeChanges } = mockStore([
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 200, y: 200, width: 100, height: 50 },
    ], [edge])
    const constraints = createLayoutConstraints(store, ['a', 'b'], 'spline')

    constraints.rects.get('a')!.positionAbsolute = { x: 40, y: 10 }
    constraints.rects.get('b')!.positionAbsolute = { x: 240, y: 210 }
    constraints.updateXYFlow()

    const changes = triggerEdgeChanges.mock.lastCall?.[0]
    expect(changes).toHaveLength(1)
    expect(changes?.[0]).toHaveProperty('item.data.points', [[140, 35], [170, 35], [210, 235], [240, 235]])
  })
})
