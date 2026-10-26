import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpeg from 'ffmpeg-static'
import { buildAss, fontsDir } from '../src/main/pipeline/captions'
it.each([
  [270, 480],
  [360, 360],
  [480, 270]
])(
  'burns positioned translucent backgrounds into real frames at %sx%s',
  (width, height) => {
    const root = mkdtempSync(join(tmpdir(), 'cutawan-overlay-render-'))
    try {
      const ass = buildAss(
        { language: 'en', durationSec: 3, segments: [] },
        {
          styleId: 'beast',
          width,
          height,
          clipStart: 0,
          clipEnd: 3,
          title: 'HOOK',
          edit: {
            hookDuration: 1,
            hookOverlay: {
              x: 0.5,
              y: 0.3,
              maxWidth: 0.6,
              fontScale: 0.06,
              backgroundOpacity: 0.5,
              outline: 0,
              shadow: 0
            }
          }
        }
      )
      writeFileSync(join(root, 'overlay.ass'), ass)
      const filter = `ass=overlay.ass:fontsdir='${fontsDir().replace(/\\/g, '/').replace(/:/g, '\\:')}'`
      const frame = (time: number): Buffer =>
        execFileSync(
          ffmpeg!,
          [
            '-v',
            'error',
            '-threads',
            '1',
            '-f',
            'lavfi',
            '-i',
            `color=white:s=${width}x${height}:r=1:d=3`,
            '-vf',
            filter,
            '-ss',
            String(time),
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            'pipe:1'
          ],
          { cwd: root, windowsHide: true, maxBuffer: 4_000_000 }
        )
      const first = frame(0),
        later = frame(2)
      const pixel = (data: Buffer, x: number, y: number): number =>
        data[(Math.round(y) * width + Math.round(x)) * 3]
      expect(pixel(first, width * 0.25, height * 0.3)).toBeGreaterThan(110)
      expect(pixel(first, width * 0.25, height * 0.3)).toBeLessThan(145)
      expect(pixel(first, width * 0.1, height * 0.3)).toBeGreaterThan(245)
      expect(pixel(later, width * 0.25, height * 0.3)).toBeGreaterThan(245)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  20000
)

it('exports a hook independently when subtitles and the transcript are disabled', async () => {
  const { runFfmpeg, probeVideo } = await import('../src/main/pipeline/ffmpeg')
  const { renderClip } = await import('../src/main/pipeline/render')
  const root = mkdtempSync(join(tmpdir(), 'cutawan-hook-only-'))
  try {
    const sourcePath = join(root, 'source.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=white:s=320x180:r=3:d=2', '-c:v', 'libx264', sourcePath])
    const source = await probeVideo(sourcePath)
    const clip = {
      id: 'hook-only', suggestedStart: 0, suggestedEnd: 2, summary: '', viralityScore: 0, viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, title: 'Hook only', hook: 'HOOK', focusTrack: null, broll: [],
      edit: { aspect: 'original', reframeMode: 'crop', framing: 'manual', focusX: .5, tightenCuts: false, autoZoom: false, captionsEnabled: false, captionStyleId: 'beast', showTitle: true, start: 0, end: 2, hookDuration: 1, hookOverlay: { y: .3, maxWidth: .6, backgroundOpacity: .5 } }
    } as import('../src/shared/types').Clip
    const output = join(root, 'export.mp4')
    await renderClip({ clip, source, transcript: null, outputPath: output, encoder: 'cpu', quality: 'draft' })
    const info = await probeVideo(output)
    expect(info).toMatchObject({ width: 320, height: 180, hasAudio: false })
    const frame = execFileSync(ffmpeg!, ['-v', 'error', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true })
    expect(frame[(54 * 320 + 80) * 3]).toBeLessThan(150)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 20000)

