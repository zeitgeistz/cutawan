import {
  trackClip,
  recordSave,
  undo as undoEdit,
  redo as redoEdit
} from '../src/shared/editHistory'
import type { Clip } from '../src/shared/types'
import { describe, expect, it } from 'vitest'
import {
  compactHook,
  canvasPoint,
  moveOverlay,
  overlaySettings,
  overlayAnchor,
  hookLines
} from '../src/shared/textOverlay'
import { getCaptionStyle } from '../src/shared/captionStyles'
import { buildAss, assFontSize } from '../src/main/pipeline/captions'
import { makeTranscript } from './helpers'
import type { ClipEditState } from '../src/shared/types'
const style = getCaptionStyle('beast')
describe('direct text manipulation', () => {
  it.each([0.25, 0.5, 1, 2])(
    'maps scaled canvas pointers at scale %s without including outer letterboxing',
    (scale) => {
      const rect = {
        left: 100,
        top: 80,
        width: 1080 * scale,
        height: 1920 * scale
      }
      const start = canvasPoint(
        100 + rect.width / 2,
        80 + rect.height / 2,
        rect
      )
      const end = canvasPoint(
        100 + rect.width * 0.7,
        80 + rect.height * 0.3,
        rect
      )
      const moved = moveOverlay(
        overlaySettings(undefined, style),
        end.x - start.x,
        end.y - start.y
      )
      expect(moved.x).toBeCloseTo(0.7)
      expect(moved.y).toBeCloseTo(0.52)
    }
  )
  it('bounds moves and corner resizing', () => {
    const initial = overlaySettings(undefined, style)
    expect(moveOverlay(initial, 5, -5)).toEqual({ x: 1, y: 0 })
    expect(moveOverlay(initial, 5, -5, true)).toEqual({
      maxWidth: 1,
      fontScale: 0.015
    })
  })
  it('keeps old projects optional and falls back to their caption preset', () => {
    const old = JSON.parse('{"captionStyleId":"minimal"}') as ClipEditState
    const preset = getCaptionStyle(old.captionStyleId)
    expect(overlaySettings(old.captionOverlay, preset).y).toBe(0.8)
    expect(overlaySettings(old.captionOverlay, preset).fontScale).toBe(0.038)
    expect(old.captionOverlay).toBeUndefined()
  })
  it('round trips independent settings and resets to automatic placement', () => {
    const edit = {
      captionOverlay: { x: 0.2, y: 0.3, fontScale: 0.06 },
      hookOverlay: { x: 0.7, y: 0.1, backgroundOpacity: 0.4 },
      hookDuration: 2.5
    }
    expect(JSON.parse(JSON.stringify(edit))).toEqual(edit)
    expect(overlaySettings(edit.hookOverlay, style, true).x).toBe(0.7)
    expect(overlaySettings(undefined, style).y).toBe(style.positionY)
  })
  it.each([
    [1080, 1920],
    [1080, 1080],
    [1920, 1080]
  ])('renders shared geometry at %sx%s', (width, height) => {
    const transcript = makeTranscript(['hello'])
    const settings = {
      x: 0.6,
      y: 0.35,
      fontScale: 0.06,
      maxWidth: 0.6,
      backgroundOpacity: 0.4,
      align: 'right' as const
    }
    const resolved = overlaySettings(settings, style)
    const anchor = overlayAnchor(resolved, width)
    const ass = buildAss(transcript, {
      styleId: 'beast',
      width,
      height,
      clipStart: 0,
      clipEnd: 8,
      title: 'The hook title',
      edit: {
        captionOverlay: settings,
        hookOverlay: settings,
        hookDuration: 2.5
      },
      positionRanges: [{ start: 0, end: 8, positionY: 0.9 }]
    })
    expect(ass).toContain(
      `\\an6\\q2\\pos(${anchor.x},${Math.round(height * 0.35)})`
    )
    expect(ass).toContain(
      `Style: Caption,Anton,${assFontSize(0.06 * height, null)},`
    )
    expect(ass).toContain('0:00:02.50,Title')
    expect(ass).toContain('\\1a&H99&')
    expect(ass).toContain(`l ${Math.round(width * 0.6)} 0`)
    expect(
      hookLines('The hook title', resolved, width / height).length
    ).toBeLessThanOrEqual(2)
  })
})

it('groups local overlay drag updates into one persisted undo step', () => {
  const original = {
    id: 'overlay-history',
    edit: { captionStyleId: 'beast' }
  } as Clip
  trackClip(original)
  const moved = {
    ...original,
    edit: { ...original.edit, captionOverlay: { x: 0.65, y: 0.4 } }
  }
  expect(recordSave(moved)).toBe(true)
  const undone = undoEdit(moved)!
  expect(undone.edit.captionOverlay).toBeUndefined()
  expect(undoEdit(undone)).toBeNull()
  expect(redoEdit(undone)!.edit.captionOverlay).toEqual({ x: 0.65, y: 0.4 })
})


it('fits long hooks into two compact lines without dropping text', () => {
  const text = 'A longer hook title that must remain readable within the chosen video width'
  const settings = compactHook(overlaySettings(undefined, style, true), text, 9 / 16)
  const lines = hookLines(text, settings, 9 / 16)
  expect(lines).toHaveLength(2)
  expect(lines.join(' ')).toBe(text)
  expect(Math.max(...lines.map(line => line.length)) * .62 * settings.fontScale).toBeLessThanOrEqual((9 / 16) * settings.maxWidth + .0001)
})
