import { describe, it, expect } from 'vitest'
import {
  MIN_SCALE,
  MAX_SCALE,
  MAX_FIT_SCALE,
  clampScale,
  parseSvgSize,
  computeFit,
  centerOffset,
  zoomAtPoint,
  steppedScale,
  wheelZoomFactor,
  detectDiagramType,
} from './mermaid-zoom'

describe('clampScale', () => {
  it('should keep a scale that is already inside the range', () => {
    expect(clampScale(1.5)).toBe(1.5)
  })

  it('should clamp below the minimum up to MIN_SCALE', () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE)
  })

  it('should clamp above the maximum down to MAX_SCALE', () => {
    expect(clampScale(9999)).toBe(MAX_SCALE)
  })

  it('should fall back to the minimum for a non-finite scale', () => {
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE)
  })
})

describe('parseSvgSize', () => {
  it('should read the natural size from a viewBox', () => {
    expect(parseSvgSize('0 0 640 480')).toEqual({ width: 640, height: 480 })
  })

  it('should accept a comma-separated viewBox', () => {
    expect(parseSvgSize('0,0,120,60')).toEqual({ width: 120, height: 60 })
  })

  it('should prefer the viewBox over percentage width/height attributes', () => {
    expect(parseSvgSize('0 0 300 200', '100%', '100%')).toEqual({ width: 300, height: 200 })
  })

  it('should fall back to px width/height attributes when there is no viewBox', () => {
    expect(parseSvgSize(null, '420px', '260px')).toEqual({ width: 420, height: 260 })
  })

  it('should return null when only percentage dimensions are available', () => {
    expect(parseSvgSize(null, '100%', '100%')).toBeNull()
  })

  it('should return null for a malformed viewBox with no usable fallback', () => {
    expect(parseSvgSize('0 0 abc', null, null)).toBeNull()
  })

  it('should reject a zero-area viewBox', () => {
    expect(parseSvgSize('0 0 0 400')).toBeNull()
  })
})

describe('computeFit', () => {
  it('should shrink an oversized diagram to fit the padded viewport', () => {
    const fit = computeFit({ width: 2000, height: 1000 }, { width: 1080, height: 800 }, 40)
    // Width is the binding dimension: (1080 - 80) / 2000
    expect(fit.scale).toBeCloseTo(0.5, 5)
  })

  it('should be bound by whichever axis runs out first', () => {
    const fit = computeFit({ width: 400, height: 4000 }, { width: 1000, height: 1000 }, 0)
    expect(fit.scale).toBeCloseTo(0.25, 5)
  })

  it('should upscale a small diagram — the point of the feature', () => {
    const fit = computeFit({ width: 200, height: 100 }, { width: 1000, height: 800 }, 40)
    expect(fit.scale).toBeGreaterThan(1)
  })

  it('should cap the initial upscale at MAX_FIT_SCALE', () => {
    const fit = computeFit({ width: 20, height: 10 }, { width: 2000, height: 1600 }, 40)
    expect(fit.scale).toBe(MAX_FIT_SCALE)
  })

  it('should centre the scaled diagram in the viewport', () => {
    const fit = computeFit({ width: 1000, height: 500 }, { width: 1080, height: 800 }, 40)
    expect(fit.tx).toBeCloseTo((1080 - 1000 * fit.scale) / 2, 5)
    expect(fit.ty).toBeCloseTo((800 - 500 * fit.scale) / 2, 5)
  })

  it('should degrade to an identity transform for a zero-sized diagram', () => {
    expect(computeFit({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    })
  })
})

describe('centerOffset', () => {
  it('should offset by half the leftover space on each axis', () => {
    expect(centerOffset({ width: 200, height: 100 }, { width: 1000, height: 600 }, 2)).toEqual({
      tx: 300,
      ty: 200,
    })
  })
})

describe('zoomAtPoint', () => {
  it('should keep the content point under the pivot fixed', () => {
    const before = { scale: 1, tx: 100, ty: 50 }
    const pivot = { x: 400, y: 300 }
    // Content coordinate currently under the pivot.
    const contentX = (pivot.x - before.tx) / before.scale
    const contentY = (pivot.y - before.ty) / before.scale

    const after = zoomAtPoint(before, 2.5, pivot)

    expect(after.tx + contentX * after.scale).toBeCloseTo(pivot.x, 6)
    expect(after.ty + contentY * after.scale).toBeCloseTo(pivot.y, 6)
  })

  it('should apply the requested scale when it is inside the range', () => {
    expect(zoomAtPoint({ scale: 1, tx: 0, ty: 0 }, 3, { x: 0, y: 0 }).scale).toBe(3)
  })

  it('should clamp the requested scale to the allowed range', () => {
    expect(zoomAtPoint({ scale: 1, tx: 0, ty: 0 }, 100, { x: 10, y: 10 }).scale).toBe(MAX_SCALE)
  })

  it('should not nudge the pan when already clamped at the limit', () => {
    const atMax = { scale: MAX_SCALE, tx: 42, ty: -17 }
    expect(zoomAtPoint(atMax, MAX_SCALE * 2, { x: 500, y: 500 })).toBe(atMax)
  })
})

describe('steppedScale', () => {
  it('should enlarge by one step for a positive direction', () => {
    expect(steppedScale(1, 1)).toBeCloseTo(1.25, 5)
  })

  it('should shrink by one step for a negative direction', () => {
    expect(steppedScale(1, -1)).toBeCloseTo(0.8, 5)
  })

  it('should stay inside the range at the ceiling', () => {
    expect(steppedScale(MAX_SCALE, 1)).toBe(MAX_SCALE)
  })
})

describe('wheelZoomFactor', () => {
  it('should return a factor above 1 when scrolling up (negative delta)', () => {
    expect(wheelZoomFactor(-40)).toBeGreaterThan(1)
  })

  it('should return a factor below 1 when scrolling down', () => {
    expect(wheelZoomFactor(40)).toBeLessThan(1)
  })

  it('should be a no-op for a zero delta', () => {
    expect(wheelZoomFactor(0)).toBe(1)
  })

  it('should normalise line-mode deltas so a mouse wheel is not dead', () => {
    // 3 lines (deltaMode 1) should zoom about as much as 48 pixels.
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48, 0), 6)
  })

  it('should clamp a flung trackpad gesture to a sane per-event factor', () => {
    expect(wheelZoomFactor(-100000)).toBe(wheelZoomFactor(-160))
  })
})

describe('detectDiagramType', () => {
  it('should read the leading keyword', () => {
    expect(detectDiagramType('flowchart TD\n  A --> B')).toBe('flowchart')
  })

  it('should keep camelCase diagram names intact', () => {
    expect(detectDiagramType('sequenceDiagram\n  A ->> B: hi')).toBe('sequenceDiagram')
  })

  it('should keep hyphenated diagram names intact', () => {
    expect(detectDiagramType('stateDiagram-v2\n  [*] --> Idle')).toBe('stateDiagram-v2')
  })

  it('should skip %% comments and init directives', () => {
    expect(detectDiagramType("%%{init: {'theme':'base'}}%%\n%% a note\npie title Pets")).toBe('pie')
  })

  it('should skip a YAML frontmatter block', () => {
    expect(detectDiagramType('---\ntitle: Demo\n---\ngantt\n  title A')).toBe('gantt')
  })

  it('should skip leading blank lines', () => {
    expect(detectDiagramType('\n\n  mindmap\n  root')).toBe('mindmap')
  })

  it('should return null for empty source', () => {
    expect(detectDiagramType('')).toBeNull()
  })

  it('should return null when nothing looks like a diagram declaration', () => {
    expect(detectDiagramType('%% only a comment')).toBeNull()
  })
})
