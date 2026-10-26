import type { TextOverlaySettings } from './types'
import type { CaptionStyle } from './captionStyles'
export const clamp = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n))
export function overlaySettings(
  value: TextOverlaySettings | undefined,
  style: CaptionStyle,
  hook = false
): Required<TextOverlaySettings> {
  const number = (
    v: number | undefined,
    fallback: number,
    min: number,
    max: number
  ): number => (Number.isFinite(v) ? clamp(v!, min, max) : fallback)
  return {
    x: number(value?.x, 0.5, 0, 1),
    y: number(value?.y, hook ? 0.12 : style.positionY, 0, 1),
    fontScale: number(
      value?.fontScale,
      hook ? 0.044 : style.fontScale,
      0.015,
      0.15
    ),
    maxWidth: number(value?.maxWidth, hook ? 0.8 : 0.9, 0.1, 1),
    align:
      value?.align === 'left' || value?.align === 'right'
        ? value.align
        : 'center',
    backgroundOpacity: number(value?.backgroundOpacity, 0, 0, 1),
    outline: number(value?.outline, hook ? 1.6 : style.outlineWidth, 0, 10),
    shadow: number(value?.shadow, hook ? 1 : style.shadow, 0, 10)
  }
}
export function canvasPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number }
): { x: number; y: number } {
  return {
    x: (x - rect.left) / Math.max(1, rect.width),
    y: (y - rect.top) / Math.max(1, rect.height)
  }
}
export function moveOverlay(
  initial: Required<TextOverlaySettings>,
  dx: number,
  dy: number,
  resize = false
): TextOverlaySettings {
  return resize
    ? {
        fontScale: clamp(initial.fontScale + dy * 0.25, 0.015, 0.15),
        maxWidth: clamp(initial.maxWidth + dx * 2, 0.1, 1)
      }
    : { x: clamp(initial.x + dx, 0, 1), y: clamp(initial.y + dy, 0, 1) }
}
export function hookLines(
  text: string,
  settings: Required<TextOverlaySettings>,
  aspect: number
): string[] {
  const limit = Math.max(
    1,
    Math.floor((aspect * settings.maxWidth) / (settings.fontScale * 0.58))
  )
  const words = text.trim().split(/\s+/)
  if (words.join(' ').length <= limit || words.length < 2) return [words.join(' ')]
  let split = 1, best = Infinity
  for (let i = 1; i < words.length; i++) {
    const difference = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length)
    if (difference < best) { best = difference; split = i }
  }
  return [words.slice(0, split).join(' '), words.slice(split).join(' ')]
}

export function overlayAnchor(
  settings: Required<TextOverlaySettings>,
  width: number
): { alignment: number; x: number } {
  const alignment =
    settings.align === 'left' ? 4 : settings.align === 'right' ? 6 : 5
  return {
    alignment,
    x: Math.round(
      width *
        (settings.x +
          (alignment === 4
            ? -settings.maxWidth / 2
            : alignment === 6
              ? settings.maxWidth / 2
              : 0))
    )
  }
}

/** Duration is measured on the exported clock, after removed source ranges. */
export function hookDuration(value: number | undefined): number {
  return Number.isFinite(value) ? clamp(value!, 0, 60) : 4
}

/** Keep the whole hook in at most two lines; the chosen font size is a ceiling. */
export function compactHook(settings: Required<TextOverlaySettings>, text: string, aspect: number): Required<TextOverlaySettings> {
  const longest = Math.max(1, ...hookLines(text, settings, aspect).map(line => line.length))
  return { ...settings, fontScale: Math.min(settings.fontScale, aspect * settings.maxWidth / (longest * .62)) }
}
