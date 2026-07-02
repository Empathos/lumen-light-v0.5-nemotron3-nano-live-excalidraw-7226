import { describe, it, expect } from 'vitest'
import { describeScene } from './summarizeScene'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

/** Fake just the slice of the API the summarizer touches. */
function apiWith(
  elements: Record<string, unknown>[],
  appState: Record<string, unknown> = {},
): ExcalidrawImperativeAPI {
  const withDefaults = elements.map((e, i) => ({
    id: `el-${i}`,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    isDeleted: false,
    ...e,
  }))
  return {
    getSceneElements: () => withDefaults,
    getAppState: () => appState,
  } as unknown as ExcalidrawImperativeAPI
}

describe('describeScene', () => {
  it('returns null for an empty board', () => {
    expect(describeScene(apiWith([]))).toBeNull()
    expect(describeScene(null)).toBeNull()
  })

  it('renders counts, screenshot hosts, and labels from the inventory', () => {
    const text = describeScene(
      apiWith([
        { type: 'rectangle' },
        { type: 'rectangle' },
        { type: 'arrow' },
        { type: 'text', text: 'Plan A' },
        {
          type: 'image',
          customData: { lumenImage: { kind: 'screenshot', label: 'https://www.cnn.com/a' } },
        },
      ]),
    )
    expect(text).toContain('2 shapes/nodes')
    expect(text).toContain('1 connector (arrows)')
    expect(text).toContain('1 website screenshot (cnn.com)')
    expect(text).toContain('"Plan A"')
    expect(text).toContain('call capture_canvas')
  })

  it('mentions layout (not image content) when the board has no images', () => {
    const text = describeScene(apiWith([{ type: 'rectangle' }]))
    expect(text).toContain('To see the exact layout, call capture_canvas.')
  })

  it('reports the selection as USER FOCUS (IDEA-007)', () => {
    const text = describeScene(
      apiWith(
        [
          { id: 'r1', type: 'rectangle' },
          { id: 't1', type: 'text', text: 'Auth Service', containerId: 'r1' },
          {
            id: 'img1',
            type: 'image',
            customData: { lumenImage: { kind: 'screenshot', label: 'https://cnn.com/a' } },
          },
        ],
        { selectedElementIds: { img1: true } },
      ),
    )
    expect(text).toContain('USER FOCUS: the user currently has a website screenshot (cnn.com) selected')
    expect(text).toContain('"this" / "this one" means that selection')
  })

  it('reports in-view counts when nothing is selected but the viewport is known', () => {
    const text = describeScene(
      apiWith(
        [
          { id: 'a', type: 'rectangle', x: 10, y: 10 },
          { id: 'b', type: 'rectangle', x: 5000, y: 5000 },
        ],
        { selectedElementIds: {}, scrollX: 0, scrollY: 0, zoom: { value: 1 }, width: 1200, height: 800 },
      ),
    )
    expect(text).toContain('USER FOCUS: 1 of 2 items are on the user\'s screen')
  })

  it('emits no USER FOCUS line without selection or viewport info', () => {
    const text = describeScene(apiWith([{ type: 'rectangle' }]))
    expect(text).not.toContain('USER FOCUS')
  })

  it('surfaces pre-read image notes (LL-012)', () => {
    const text = describeScene(
      apiWith([
        {
          type: 'image',
          customData: {
            lumenImage: { kind: 'screenshot', label: 'https://msn.com' },
            lumenTags: { 'ai.description': 'MSN homepage; top headline: Michael Byrne dead at 82.' },
          },
        },
      ]),
    )
    expect(text).toContain('Image contents (pre-read, literal):')
    expect(text).toContain('Michael Byrne dead at 82')
  })

  it('never reports a board with only hand-drawn content as empty (BUG-004)', () => {
    const text = describeScene(apiWith([{ type: 'freedraw' }, { type: 'freedraw' }, { type: 'line' }]))
    expect(text).not.toBeNull()
    expect(text).toContain('3 other elements')
    // Hand-drawn content is visual: the model must be pointed at capture_canvas
    // so it can recognize what was drawn, not just count strokes.
    expect(text).toContain('call capture_canvas to actually see the board')
  })
})
