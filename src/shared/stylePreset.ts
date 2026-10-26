import { DEFAULT_CAPTION_STYLE_ID } from './captionStyles'
import { userClipEdit } from './reframe'
import type { ClipEditState, StylePreset } from './types'

/** Edit fields a style preset carries; trim, cuts, splits and text stay per clip. */
export const STYLE_PRESET_KEYS = [
  'captionOverlay', 'hookOverlay', 'hookDuration', 'aspect', 'reframeMode', 'framing',
  'tightenCuts', 'autoZoom', 'captionsEnabled', 'captionStyleId', 'captionFontFamily', 'showTitle'
] as const

/** Defaults new AI-highlight clips are created with (the preset's required fields). */
export const DEFAULT_STYLE_FIELDS = {
  aspect: '9:16',
  reframeMode: 'crop',
  framing: 'manual',
  tightenCuts: true,
  autoZoom: true,
  captionsEnabled: true,
  captionStyleId: DEFAULT_CAPTION_STYLE_ID,
  showTitle: false
} as const satisfies Partial<ClipEditState>

/** Preset fields of an edit; unset optional fields are omitted. */
export function pickStylePreset(edit: Partial<ClipEditState>): StylePreset {
  const preset: Record<string, unknown> = {}
  for (const key of STYLE_PRESET_KEYS) if (edit[key] !== undefined) preset[key] = edit[key]
  return preset as StylePreset
}

export function sameStylePreset(a: StylePreset, b: StylePreset): boolean {
  return JSON.stringify(pickStylePreset(a)) === JSON.stringify(pickStylePreset(b))
}

/**
 * The edit with the preset's fields applied, changing nothing else. A preset
 * is a complete snapshot, so optional fields it lacks are cleared. Returns the
 * same object when nothing differs; otherwise the change counts as a user
 * layout choice, like any other edit made in the editor.
 */
export function applyStylePreset(edit: ClipEditState, preset: StylePreset | null | undefined): ClipEditState {
  if (!preset) return edit
  const wanted = pickStylePreset(preset)
  const patch: Partial<ClipEditState> = {
    captionOverlay: undefined, hookOverlay: undefined, hookDuration: undefined,
    autoZoom: undefined, captionFontFamily: undefined, ...wanted
  }
  if (sameStylePreset(edit, patch)) return edit
  return userClipEdit(edit, patch)
}

/** Preset fields restored to what a new clip starts with; overlays and custom font cleared. */
export function defaultStyleEdit(): Partial<ClipEditState> {
  return {
    ...DEFAULT_STYLE_FIELDS,
    captionOverlay: undefined, hookOverlay: undefined, hookDuration: undefined, captionFontFamily: undefined
  }
}
