import { describe, expect, it } from 'vitest'
import { applyStylePreset, defaultStyleEdit, pickStylePreset } from '../src/shared/stylePreset'
import type { ClipEditState } from '../src/shared/types'

const edit: ClipEditState = {
  start: 10, end: 40, aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: true,
  focusX: 0.3, captionsEnabled: true, captionStyleId: 'beast', showTitle: false,
  cuts: [{ start: 12, end: 14 }], splits: [20], restored: [{ start: 1, end: 2 }],
  compositionPreference: 'stacked', captionOverlay: { x: 0.2 }
}
const styled: ClipEditState = {
  ...edit, aspect: '1:1', reframeMode: 'fit-blur', framing: 'auto', tightenCuts: false, autoZoom: true,
  captionsEnabled: false, captionStyleId: 'clean', showTitle: true, captionFontFamily: 'Inter',
  hookOverlay: { y: 0.1 }, hookDuration: 6, captionOverlay: undefined
}

describe('pickStylePreset', () => {
  it('copies only preset fields', () => {
    const preset = pickStylePreset(styled)
    expect(preset).toEqual({
      aspect: '1:1', reframeMode: 'fit-blur', framing: 'auto', tightenCuts: false, autoZoom: true,
      captionsEnabled: false, captionStyleId: 'clean', showTitle: true, captionFontFamily: 'Inter',
      hookOverlay: { y: 0.1 }, hookDuration: 6
    })
    for (const key of ['start', 'end', 'cuts', 'restored', 'splits', 'focusX', 'compositionPreference']) {
      expect(preset).not.toHaveProperty(key)
    }
  })
})

describe('applyStylePreset', () => {
  it('copies preset fields and leaves trim, cuts and layout extras alone', () => {
    const out = applyStylePreset(edit, pickStylePreset(styled))
    expect(out).toMatchObject(pickStylePreset(styled))
    expect(out.captionOverlay).toBeUndefined()
    expect(out).toMatchObject({
      start: 10, end: 40, focusX: 0.3, cuts: [{ start: 12, end: 14 }], splits: [20],
      restored: [{ start: 1, end: 2 }], compositionPreference: 'stacked'
    })
    expect(out.layoutChosen).toBe(true)
  })

  it('is identity with no preset', () => {
    expect(applyStylePreset(edit, undefined)).toBe(edit)
    expect(applyStylePreset(edit, null)).toBe(edit)
  })

  it('returns the same object when nothing differs', () => {
    expect(applyStylePreset(edit, pickStylePreset(edit))).toBe(edit)
  })

  it('does not mark layout chosen when nothing differs', () => {
    expect(applyStylePreset(edit, pickStylePreset(edit)).layoutChosen).toBeUndefined()
  })

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(edit)
    applyStylePreset(edit, pickStylePreset(styled))
    expect(JSON.stringify(edit)).toBe(before)
  })
})

describe('defaultStyleEdit', () => {
  it('restores new-clip defaults and clears overlays', () => {
    const out = applyStylePreset(styled, defaultStyleEdit())
    expect(out).toMatchObject({
      aspect: '9:16', reframeMode: 'crop', framing: 'manual', tightenCuts: true, autoZoom: true,
      captionsEnabled: true, captionStyleId: 'beast', showTitle: false, start: 10, end: 40
    })
    expect(out.hookOverlay).toBeUndefined()
    expect(out.hookDuration).toBeUndefined()
    expect(out.captionFontFamily).toBeUndefined()
  })
})
