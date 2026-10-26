import {
  overlaySettings,
  hookLines,
  overlayAnchor,
  hookDuration,
  compactHook
} from '@shared/textOverlay'
import type { ClipEditState } from '@shared/types'
import { join } from 'node:path'
import { app } from 'electron'
import type { Transcript, BrandColors } from '@shared/types'
import { resolveCaptionStyle, type CaptionStyle } from '@shared/captionStyles'
import {
  captionPositionAt,
  type CaptionPositionRange
} from '@shared/contentRegion'
import type { FontMetrics } from '../fonts'
import {
  CAPTION_SAFE_WIDTH,
  captionLayoutBudget,
  groupDisplayEnd,
  groupWords,
  wordsInRange,
  type WordGroup
} from '@shared/captionLayout'

/**
 * Bundled caption fonts (Anton, Poppins — OFL licensed) so exports render
 * identically on every OS instead of falling back to system fonts.
 * `app` is undefined when running outside Electron (test scripts).
 */
export function fontsDir(): string {
  if (app?.isPackaged) return join(process.resourcesPath, 'fonts')
  const base = app?.getAppPath?.() ?? process.cwd()
  return join(base, 'resources', 'fonts')
}

/**
 * Generates ASS (Advanced SubStation Alpha) subtitles with word-level karaoke
 * highlighting: for every spoken word we emit one Dialogue event that shows
 * the whole word group with the active word emphasised. libass renders this
 * as the classic "Opus Clip" style animated captions when burned in.
 */

function assTime(sec: number): string {
  const clamped = Math.max(0, sec)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = Math.floor(clamped % 60)
  const cs = Math.floor((clamped - Math.floor(clamped)) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** "#RRGGBB" -> ASS "&HBBGGRR&" (no alpha). */
function assColor(hex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H${b}${g}${r}&`.toUpperCase()
}

/** "#RRGGBB" -> ASS style colour with explicit zero alpha "&H00BBGGRR". */
function assStyleColor(hex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H00${b}${g}${r}`.toUpperCase()
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ')
}

function renderGroupText(
  group: WordGroup,
  activeIndex: number,
  style: CaptionStyle
): string {
  const highlight = assColor(style.highlightColor)
  const base = assColor(style.textColor)
  const lines: string[] = []
  let index = 0
  for (const line of group.lines) {
    const parts: string[] = []
    for (const word of line) {
      const raw = escapeAss(word.text)
      const text = style.uppercase ? raw.toUpperCase() : raw
      if (index === activeIndex) {
        const pop = '\\t(0,70,\\fscx109\\fscy109)'
        if (style.highlightBoxColor) {
          // Fat outline in the pill colour approximates a rounded label.
          const pill = assColor(style.highlightBoxColor)
          parts.push(
            `{\\c${highlight}\\bord10\\3c${pill}\\fscx100\\fscy100${pop}}${text}{\\r}`
          )
        } else {
          parts.push(`{\\c${highlight}\\fscx100\\fscy100${pop}}${text}{\\r}`)
        }
      } else {
        parts.push(`{\\c${base}}${text}{\\r}`)
      }
      index++
    }
    lines.push(parts.join(' '))
  }
  // Hard line breaks: the layout decided the lines (\\q2 on the event keeps
  // libass from re-wrapping them).
  return lines.join('\\N')
}

/** "#RRGGBB" -> ASS style colour with explicit alpha "&HAA BB GGRR". */
function assStyleColorWithAlpha(hex: string, alphaHex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H${alphaHex}${b}${g}${r}`.toUpperCase()
}

/**
 * Typical `winSpan / unitsPerEm` across the fonts we ship and the ones users
 * upload. Only used when a font's metrics cannot be read; getting it roughly
 * right beats reverting to the old em-size assumption, which rendered every
 * caption at about 58% of its intended size.
 */
const DEFAULT_WIN_SPAN_RATIO = 1.75

/**
 * Convert a CSS-style em size into the ASS `Fontsize` that renders at the same
 * visible size.
 *
 * They are not the same unit. CSS `font-size` sets the em square, whereas
 * libass (following VSFilter) sizes text against the font's OS/2 window
 * ascent + descent. That span is larger than the em on essentially every font,
 * so feeding an em size straight into `Fontsize` renders text far too small —
 * measured at 59% for Anton and 58% for Poppins, which is exactly the gap
 * between the live preview and the burned-in captions.
 */
export function assFontSize(emPx: number, metrics: FontMetrics | null): number {
  const ratio = metrics
    ? metrics.winSpan / metrics.unitsPerEm
    : DEFAULT_WIN_SPAN_RATIO
  return Math.round(emPx * ratio)
}

export interface CaptionOptions {
  edit?: Partial<ClipEditState>
  styleId: string
  /** Output video dimensions the subtitles will be rendered onto. */
  width: number
  height: number
  /**
   * Metrics of the resolved caption font, for the em-size conversion above.
   * Null falls back to `DEFAULT_WIN_SPAN_RATIO`.
   */
  fontMetrics?: FontMetrics | null
  /** Clip boundaries in source-video seconds; events are re-based to 0. */
  clipStart: number
  clipEnd: number
  /** Optional title overlaid near the top for the first seconds of the clip. */
  title?: string
  /** Custom font family overriding the style's font (must exist in fontsdir). */
  fontFamily?: string
  /** App-wide brand palette merged onto the caption preset. */
  brandColors?: BrandColors | null
  /** Source-time layout bands that keep captions clear of enlarged detail. */
  positionRanges?: CaptionPositionRange[]
}

export function buildAss(transcript: Transcript, opts: CaptionOptions): string {
  const base = resolveCaptionStyle(
    opts.styleId,
    opts.brandColors,
    opts.fontFamily
  )
  const caption = overlaySettings(opts.edit?.captionOverlay, base)
  const hook = compactHook(
    overlaySettings(opts.edit?.hookOverlay, base, true),
    opts.title ?? '',
    opts.width / opts.height
  )
  const style = {
    ...base,
    fontScale: caption.fontScale,
    maxWidth: caption.maxWidth,
    outlineWidth: caption.outline,
    shadow: caption.shadow
  }
  const fontSize = assFontSize(
    style.fontScale * opts.height,
    opts.fontMetrics ?? null
  )
  // Captions are positioned per event with \an5\pos so the block is centred on
  // the style's anchor line exactly as the preview centres it (translateY -50%).
  // A bottom-aligned style with MarginV would grow upwards from that line and
  // sit half a block higher than the preview on every two-line caption.
  const { alignment: align, x: captionX } = overlayAnchor(caption, opts.width)
  const hookAnchor = overlayAnchor(hook, opts.width)
  const marginH = Math.round((opts.width * (1 - CAPTION_SAFE_WIDTH)) / 2)
  const primary = assStyleColor(style.textColor)
  const outline = assStyleColor(style.outlineColor)
  const brandColors = opts.brandColors
  const hookText = assStyleColor(
    brandColors?.enabled ? brandColors.hookTextColor : '#FFFFFF'
  )
  const boxAlpha = Math.round((1 - hook.backgroundOpacity) * 255)
    .toString(16)
    .padStart(2, '0')
  const titleBox = brandColors?.enabled
    ? assStyleColorWithAlpha(brandColors.hookBackgroundColor, boxAlpha)
    : assStyleColorWithAlpha('#000000', boxAlpha)
  const titleShadowColor = '&H00000000'

  // Text and optional background are separate events so background opacity
  // never changes the independent outline or shadow.
  const titleFontSize = assFontSize(
    opts.height * hook.fontScale,
    opts.fontMetrics ?? null
  )
  const titleMarginV = Math.round(opts.height * 0.07)
  const titleMarginH = Math.round(opts.width * 0.1)
  const titleShadow = hook.shadow

  const captionBox = assStyleColorWithAlpha(
    '#000000',
    Math.round((1 - caption.backgroundOpacity) * 255)
      .toString(16)
      .padStart(2, '0')
  )
  const header = `[Script Info]
Title: Cutawan captions
ScriptType: v4.00+
PlayResX: ${opts.width}
PlayResY: ${opts.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${style.fontFamily},${fontSize},${primary},${primary},${outline},&H00000000,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${(style.outlineWidth * opts.height) / 1920},${(style.shadow * opts.height) / 1920},5,${marginH},${marginH},0,1
Style: Title,${style.fontFamily},${titleFontSize},${hookText},${hookText},${assStyleColor('#000000')},${titleShadowColor},-1,0,0,0,100,100,0,0,1,${(hook.outline * opts.height) / 1920},${(titleShadow * opts.height) / 1920},8,${titleMarginH},${titleMarginH},${titleMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`

  const lines: string[] = []
  const background = (
    start: number,
    end: number,
    settings: typeof caption,
    count: number,
    color: string,
    lineHeight: number
  ): void => {
    if (settings.backgroundOpacity <= 0 || end <= start) return
    const width = Math.round(settings.maxWidth * opts.width)
    const height = Math.round(
      count * settings.fontScale * opts.height * lineHeight
    )
    lines.push(
      `Dialogue: -1,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\an7\\pos(${Math.round(settings.x * opts.width - width / 2)},${Math.round(settings.y * opts.height - height / 2)})\\bord0\\shad0\\1c${color.replace(/^&H../, '&H')}\\1a&H${color.slice(2, 4)}&\\p1}m 0 0 l ${width} 0 ${width} ${height} 0 ${height}{\\p0}`
    )
  }
  const clipDur = opts.clipEnd - opts.clipStart

  if (opts.title && opts.title.trim().length > 0) {
    const showFor = Math.min(hookDuration(opts.edit?.hookDuration), clipDur)
    background(
      0,
      showFor,
      hook,
      hookLines(opts.title, hook, opts.width / opts.height).length,
      titleBox,
      1.2
    )
    const titleLines = hookLines(opts.title, hook, opts.width / opts.height)
    titleLines.forEach((text, index) => {
      const y =
        hook.y * opts.height +
        (index - (titleLines.length - 1) / 2) *
          hook.fontScale *
          opts.height *
          1.2
      lines.push(
        `Dialogue: 1,${assTime(0)},${assTime(showFor)},Title,,0,0,0,,{\\an${hookAnchor.alignment}\\q2\\pos(${hookAnchor.x},${Math.round(y)})}${escapeAss(text)}`
      )
    })
  }

  const words = wordsInRange(transcript, opts.clipStart, opts.clipEnd)
  const groups = groupWords(
    words,
    captionLayoutBudget(style, opts.width / opts.height)
  )
  // \q2 turns libass wrapping off for caption events only: the layout above
  // decided their lines. Hooks use shared explicit line breaks as well.

  groups.forEach((group, gi) => {
    // The finished group holds briefly after its last word (never into the
    // next group) so pauses do not leave an empty frame.
    const groupEnd = groupDisplayEnd(groups, gi, opts.clipEnd)
    for (let i = 0; i < group.words.length; i++) {
      const w = group.words[i]
      const start = Math.max(0, w.start - opts.clipStart)
      const isLast = i === group.words.length - 1
      const next = group.words[i + 1]
      const end = Math.min(
        clipDur,
        (isLast ? groupEnd : next.start) - opts.clipStart
      )
      if (end <= start) continue
      const cuts = [
        start,
        ...new Set(
          (opts.positionRanges ?? [])
            .flatMap((r) => [r.start - opts.clipStart, r.end - opts.clipStart])
            .filter((t) => t > start && t < end)
        ),
        end
      ].sort((a, b) => a - b)
      for (let part = 0; part < cuts.length - 1; part++) {
        const from = cuts[part],
          until = cuts[part + 1]
        const position =
          opts.edit?.captionOverlay?.y != null
            ? caption.y
            : captionPositionAt(
                opts.positionRanges,
                opts.clipStart + (from + until) / 2,
                style.positionY
              )
        const anchor = `{\\an${align}\\q2\\pos(${captionX},${Math.round(position * opts.height)})}`
        background(
          from,
          until,
          { ...caption, y: position },
          group.lines.length,
          captionBox,
          1.25
        )
        // Position each line independently: libass's native leading follows
        // the font's Windows span, while CSS uses an explicit 1.25em line box.
        let wordOffset = 0
        group.lines.forEach((words, lineIndex) => {
          const y =
            position * opts.height +
            (lineIndex - (group.lines.length - 1) / 2) *
              style.fontScale *
              opts.height *
              1.25
          const lineAnchor =
            group.lines.length === 1
              ? anchor
              : `{\\an${align}\\q2\\pos(${captionX},${Math.round(y)})}`
          const lineGroup = { ...group, words, lines: [words] }
          lines.push(
            `Dialogue: 0,${assTime(from)},${assTime(until)},Caption,,0,0,0,,${lineAnchor}${renderGroupText(lineGroup, i - wordOffset, style)}`
          )
          wordOffset += words.length
        })
      }
    }
  })

  return header + lines.join('\n') + '\n'
}
