import { captionLayoutBudget, groupDisplayEnd, groupWords } from './captionLayout'
import { getCaptionStyle } from './captionStyles'
import { clipKeptSegments, TimeMap, type KeptSegment } from './tighten'
import { compactHook, hookDuration, hookLines, overlaySettings } from './textOverlay'
import type { Clip, Project, TranscriptWord } from './types'

export interface FilmcraftSequence {
  name: string
  width: number
  height: number
  fps: number
}

export interface FilmcraftPlacement {
  path: string
  track: 'V1' | 'V2'
  seconds: number
  sourceIn: number
  duration: number
  video: boolean
  audio: boolean
}

export interface FilmcraftCaption {
  text: string
  seconds: number
  durationSeconds: number
}

export interface FilmcraftGraphic {
  text: string
  seconds: number
  durationSeconds: number
  /** Filmcraft canvas pixels, [x, y]. */
  position: [number, number]
  /** Maximum text or background width in Filmcraft canvas pixels. */
  width?: number
  /** Font size in Filmcraft canvas pixels. */
  size: number
  font?: string
  alignment?: 'left' | 'center' | 'right'
  color?: string
  backgroundColor?: string
  backgroundOpacity?: number
  strokeColor?: string
  /** Stroke width in Filmcraft canvas pixels. */
  strokeWidth?: number
  /** Shadow width in Filmcraft canvas pixels. */
  shadow?: number
  /** @deprecated Legacy bridge shape. buildFilmcraftPlan never emits this. */
  box?: [number, number]
  kind: 'hook' | 'subtitle'
}

export interface FilmcraftMappingSegment {
  sourceStart: number
  sourceEnd: number
  seconds: number
  duration: number
}

export interface FilmcraftManifest {
  bridgeVersion: 1
  projectId: string
  clipId: string
  video: Project['video']
  transcript: Project['transcript']
  /** Complete original project metadata, including video and transcript. */
  project?: Project
  clip: Clip
  mapping: FilmcraftMappingSegment[]
  unsupportedFeatures: string[]
}

export interface FilmcraftPlan {
  sequence: FilmcraftSequence
  mediaPaths: string[]
  placements: FilmcraftPlacement[]
  captions: FilmcraftCaption[]
  graphics: FilmcraftGraphic[]
  warnings: string[]
  manifest: FilmcraftManifest
}

const ASPECT_DIMENSIONS = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 }
} as const

const UNSUPPORTED_FEATURES = [
  'word-highlight-animation',
  'overlay-compositing',
  'reframe-layout',
  'framing',
  'focus-track',
  'auto-zoom',
  'composition-preset',
  'speaker-split',
  'visual-layout'
]

const UNSUPPORTED_WARNINGS = [
  'Cutawan word-level caption highlights and pop or pill animation are not represented in Filmcraft subtitles.',
  'Filmcraft text background, outline, shadow, and line compositing can differ from Cutawan preview and ASS export.',
  'Cutawan reframe layout, framing, and focus-track data are preserved in the manifest but not applied.',
  'Cutawan auto zoom, composition presets, speaker splits, and visual layout data are preserved in the manifest but not applied.'
]

function validPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function splitSegments(segments: KeptSegment[], splits: number[] | undefined): KeptSegment[] {
  const points = [...new Set((splits ?? []).filter(Number.isFinite))].sort((a, b) => a - b)
  return segments.flatMap(segment => {
    const boundaries = [
      segment.start,
      ...points.filter(point => point > segment.start && point < segment.end),
      segment.end
    ]
    return boundaries.slice(0, -1).map((start, index) => ({ start, end: boundaries[index + 1] }))
  })
}

function resolvedSegments(project: Project, clip: Clip): KeptSegment[] {
  const fromEdit = clipKeptSegments(clip, project.transcript)
  const source = fromEdit ?? [{ start: clip.edit.start, end: clip.edit.end }]
  const kept = source.filter(segment =>
    Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start
  )
  return splitSegments(kept, clip.edit.splits)
}

function remappedWords(
  project: Project,
  segments: KeptSegment[],
  map: TimeMap
): TranscriptWord[] {
  if (!project.transcript) return []
  const words: TranscriptWord[] = []
  for (const segment of project.transcript.segments) {
    for (const word of segment.words) {
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start || word.text.length === 0) continue
      const intersections = segments.map(kept => ({
        start: Math.max(word.start, kept.start),
        end: Math.min(word.end, kept.end)
      })).filter(range => range.end > range.start)
      if (!intersections.length) continue
      words.push({
        ...word,
        start: map.toOutput(intersections[0].start),
        end: map.toOutput(intersections[intersections.length - 1].end)
      })
    }
  }
  return words.sort((a, b) => a.start - b.start || a.end - b.end)
}

function addMediaPath(paths: string[], path: string): void {
  if (path.length > 0 && !paths.includes(path)) paths.push(path)
}

function graphicStyle(
  settings: ReturnType<typeof overlaySettings>,
  style: ReturnType<typeof getCaptionStyle>,
  width: number,
  height: number,
  color: string,
  backgroundColor: string
): Omit<FilmcraftGraphic, 'text' | 'seconds' | 'durationSeconds' | 'kind'> {
  return {
    position: [Math.round(settings.x * width), Math.round(settings.y * height)],
    width: Math.round(settings.maxWidth * width),
    size: Math.round(settings.fontScale * height),
    font: style.fontFamily,
    alignment: settings.align,
    color,
    backgroundColor,
    backgroundOpacity: settings.backgroundOpacity,
    strokeColor: style.outlineColor,
    strokeWidth: (settings.outline * height) / 1920,
    shadow: (settings.shadow * height) / 1920
  }
}

/** Build a data-only Cutawan edit plan for the Filmcraft bridge. */
export function buildFilmcraftPlan(project: Project, clip: Clip): FilmcraftPlan {
  const warnings = [...UNSUPPORTED_WARNINGS]
  const sourceWidth = project.video.width
  const sourceHeight = project.video.height
  const sourceFps = project.video.fps
  const validDimensions = validPositive(sourceWidth) && validPositive(sourceHeight)
  const aspect = clip.edit.aspect
  const dimensions = aspect === 'original'
    ? (validDimensions ? { width: sourceWidth, height: sourceHeight } : ASPECT_DIMENSIONS['16:9'])
    : ASPECT_DIMENSIONS[aspect] ?? ASPECT_DIMENSIONS['9:16']
  const fps = validPositive(sourceFps) ? sourceFps : 30
  if (!validDimensions) warnings.push('Source dimensions are unmappable; Filmcraft sequence uses 1920x1080 fallback.')
  if (!validPositive(sourceFps)) warnings.push('Source frame rate is unmappable; Filmcraft sequence uses 30 fps fallback.')

  const segments = resolvedSegments(project, clip)
  if (!segments.length) warnings.push('Clip timing is unmappable; no source placements were created.')
  const map = new TimeMap(segments)
  const mapping = segments.map((segment, index) => ({
    sourceStart: segment.start,
    sourceEnd: segment.end,
    seconds: index === 0 ? 0 : map.toOutput(segment.start),
    duration: segment.end - segment.start
  }))
  const mediaPaths: string[] = []
  const placements: FilmcraftPlacement[] = []
  const sourcePath = project.video.path
  if (sourcePath) {
    addMediaPath(mediaPaths, sourcePath)
    for (const segment of mapping) {
      placements.push({
        path: sourcePath,
        track: 'V1',
        seconds: segment.seconds,
        sourceIn: segment.sourceStart,
        duration: segment.duration,
        video: true,
        audio: project.video.hasAudio
      })
    }
  } else {
    warnings.push('Source media path is unmappable; no linked A/V source placements were created.')
  }

  for (const broll of clip.broll) {
    if (!broll.enabled || !broll.imagePath) continue
    if (!Number.isFinite(broll.start) || !Number.isFinite(broll.end) || broll.end <= broll.start) {
      warnings.push(`B-roll "${broll.id}" timing is unmappable; it was omitted.`)
      continue
    }
    for (const kept of segments) {
      const start = Math.max(broll.start, kept.start)
      const end = Math.min(broll.end, kept.end)
      if (end <= start) continue
      addMediaPath(mediaPaths, broll.imagePath)
      placements.push({
        path: broll.imagePath,
        track: 'V2',
        seconds: map.toOutput(start),
        sourceIn: 0,
        duration: end - start,
        video: true,
        audio: false
      })
    }
  }
  placements.sort((a, b) => a.seconds - b.seconds || (a.track === 'V1' ? -1 : 1))

  const style = {
    ...getCaptionStyle(clip.edit.captionStyleId),
    ...(clip.edit.captionFontFamily ? { fontFamily: clip.edit.captionFontFamily } : {})
  }
  const captionSettings = overlaySettings(clip.edit.captionOverlay, style)
  const captions: FilmcraftCaption[] = []
  const graphics: FilmcraftGraphic[] = []
  if (clip.edit.captionsEnabled) {
    const groups = groupWords(
      remappedWords(project, segments, map),
      captionLayoutBudget(style, dimensions.width / dimensions.height)
    )
    groups.forEach((group, index) => {
      const end = groupDisplayEnd(groups, index, map.outputDuration)
      const durationSeconds = end - group.start
      if (durationSeconds <= 0) return
      const text = group.lines.map(line => line.map(word => word.text).join(' ')).join('\n')
      captions.push({ text, seconds: group.start, durationSeconds })
      graphics.push({
        text,
        seconds: group.start,
        durationSeconds,
        ...graphicStyle(
          captionSettings,
          style,
          dimensions.width,
          dimensions.height,
          style.textColor,
          '#000000'
        ),
        kind: 'subtitle'
      })
    })
  }

  const hookText = clip.hook.trim().length > 0 ? clip.hook : clip.title
  if (clip.edit.showTitle && hookText.trim().length > 0 && map.outputDuration > 0) {
    const hook = compactHook(
      overlaySettings(clip.edit.hookOverlay, style, true),
      hookText,
      dimensions.width / dimensions.height
    )
    const durationSeconds = Math.min(hookDuration(clip.edit.hookDuration), map.outputDuration)
    if (durationSeconds > 0) {
      graphics.unshift({
        text: hookLines(hookText, hook, dimensions.width / dimensions.height).join('\n'),
        seconds: 0,
        durationSeconds,
        ...graphicStyle(
          hook,
          style,
          dimensions.width,
          dimensions.height,
          '#FFFFFF',
          '#000000'
        ),
        kind: 'hook'
      })
    }
  }

  return {
    sequence: { name: clip.title, width: dimensions.width, height: dimensions.height, fps },
    mediaPaths,
    placements,
    captions,
    graphics,
    warnings,
    manifest: {
      bridgeVersion: 1,
      projectId: project.id,
      clipId: clip.id,
      video: project.video,
      transcript: project.transcript,
      project,
      clip,
      mapping,
      unsupportedFeatures: [...UNSUPPORTED_FEATURES]
    }
  }
}
