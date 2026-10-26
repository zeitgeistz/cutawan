import { describe, expect, it } from 'vitest'
import { buildFilmcraftPlan } from '../src/shared/filmcraftPlan'
import type { Clip, Project } from '../src/shared/types'

function makeProject(): Project {
  return {
    id: 'project-1',
    createdAt: 0,
    updatedAt: 0,
    name: 'Project',
    video: {
      path: '/media/source.mp4', fileName: 'source.mp4', durationSec: 10,
      width: 3840, height: 2160, fps: 24, sizeBytes: 1, hasAudio: true
    },
    transcript: {
      language: 'en', durationSec: 10,
      segments: [{
        id: 0, text: 'alpha cut omega', start: 0, end: 10,
        words: [
          { text: 'alpha', start: 0.5, end: 1 },
          { text: 'cut', start: 4, end: 5 },
          { text: 'omega', start: 8, end: 8.5 }
        ]
      }]
    },
    clips: [], prompt: '', videoType: 'auto'
  }
}

function makeClip(aspect: Clip['edit']['aspect'] = '9:16'): Clip {
  return {
    id: 'clip-1', suggestedStart: 0, suggestedEnd: 10, title: 'Filmcraft clip',
    hook: 'Watch this hook', summary: '', caption: null, viralityScore: 0,
    viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null,
    focusTrack: null, broll: [{
      id: 'broll-1', trigger: 'cut', query: 'cut', start: 2, end: 8,
      mode: 'fullscreen', imagePath: '/media/broll.jpg', sourceUrl: '', enabled: true
    }],
    edit: {
      aspect, reframeMode: 'crop', framing: 'auto', tightenCuts: false,
      focusX: .5, captionsEnabled: true, captionStyleId: 'beast', showTitle: true,
      start: 0, end: 10, cuts: [{ start: 3, end: 7 }], hookDuration: 20
    }
  }
}

describe('buildFilmcraftPlan', () => {
  it('ripple-closes source A/V cuts and preserves source alignment', () => {
    const plan = buildFilmcraftPlan(makeProject(), makeClip())
    expect(plan.placements.filter(p => p.track === 'V1')).toEqual([
      { path: '/media/source.mp4', track: 'V1', seconds: 0, sourceIn: 0, duration: 3, video: true, audio: true },
      { path: '/media/source.mp4', track: 'V1', seconds: 3, sourceIn: 7, duration: 3, video: true, audio: true }
    ])
    expect(plan.manifest.mapping).toEqual([
      { sourceStart: 0, sourceEnd: 3, seconds: 0, duration: 3 },
      { sourceStart: 7, sourceEnd: 10, seconds: 3, duration: 3 }
    ])
  })

  it('splits kept A/V items on manual razors without changing ripple duration', () => {
    const project = makeProject()
    const clip = makeClip()
    clip.edit.splits = [1, 2.5, 5, 8.5]
    project.transcript!.segments[0].words.splice(1, 0, { text: 'boundary', start: 2.25, end: 2.75 })
    const plan = buildFilmcraftPlan(project, clip)

    expect(plan.placements.filter(placement => placement.track === 'V1')).toEqual([
      { path: '/media/source.mp4', track: 'V1', seconds: 0, sourceIn: 0, duration: 1, video: true, audio: true },
      { path: '/media/source.mp4', track: 'V1', seconds: 1, sourceIn: 1, duration: 1.5, video: true, audio: true },
      { path: '/media/source.mp4', track: 'V1', seconds: 2.5, sourceIn: 2.5, duration: .5, video: true, audio: true },
      { path: '/media/source.mp4', track: 'V1', seconds: 3, sourceIn: 7, duration: 1.5, video: true, audio: true },
      { path: '/media/source.mp4', track: 'V1', seconds: 4.5, sourceIn: 8.5, duration: 1.5, video: true, audio: true }
    ])
    expect(plan.placements.filter(placement => placement.track === 'V2')).toEqual([
      { path: '/media/broll.jpg', track: 'V2', seconds: 2, sourceIn: 0, duration: .5, video: true, audio: false },
      { path: '/media/broll.jpg', track: 'V2', seconds: 2.5, sourceIn: 0, duration: .5, video: true, audio: false },
      { path: '/media/broll.jpg', track: 'V2', seconds: 3, sourceIn: 0, duration: 1, video: true, audio: false }
    ])
    expect(plan.manifest.mapping.reduce((total, segment) => total + segment.duration, 0)).toBe(6)
    expect(plan.captions.map(caption => caption.text).join(' ').match(/boundary/g)).toHaveLength(1)
  })

  it('drops removed words and splits B-roll over removed gaps', () => {
    const plan = buildFilmcraftPlan(makeProject(), makeClip())
    expect(plan.captions.map(caption => caption.text).join(' ')).toContain('alpha')
    expect(plan.captions.map(caption => caption.text).join(' ')).toContain('omega')
    expect(plan.captions.map(caption => caption.text).join(' ')).not.toContain('cut')
    expect(plan.placements.filter(p => p.track === 'V2')).toEqual([
      { path: '/media/broll.jpg', track: 'V2', seconds: 2, sourceIn: 0, duration: 1, video: true, audio: false },
      { path: '/media/broll.jpg', track: 'V2', seconds: 3, sourceIn: 0, duration: 1, video: true, audio: false }
    ])
  })

  it.each([
    ['9:16', 1080, 1920], ['1:1', 1080, 1080], ['16:9', 1920, 1080], ['original', 3840, 2160]
  ] as const)('uses %s sequence dimensions', (aspect, width, height) => {
    const plan = buildFilmcraftPlan(makeProject(), makeClip(aspect))
    expect(plan.sequence).toMatchObject({ width, height, fps: 24 })
  })

  it('uses pixel graphic styles, limits hook duration, and keeps captions separate', () => {
    const plan = buildFilmcraftPlan(makeProject(), makeClip())
    const hook = plan.graphics.find(graphic => graphic.kind === 'hook')!
    const subtitle = plan.graphics.find(graphic => graphic.kind === 'subtitle')!
    expect(hook).toMatchObject({
      durationSeconds: 6, position: [540, 230], width: 864, size: 84,
      alignment: 'center', color: '#FFFFFF', backgroundColor: '#000000',
      backgroundOpacity: 0, strokeColor: '#000000', strokeWidth: 1.6,
      shadow: 1, font: 'Anton'
    })
    expect(hook.box).toBeUndefined()
    expect(subtitle).toMatchObject({
      position: [540, 1382], width: 972, size: 100, alignment: 'center',
      color: '#FFFFFF', backgroundColor: '#000000', backgroundOpacity: 0,
      strokeColor: '#000000', strokeWidth: 3.2, shadow: 1, font: 'Anton'
    })
    expect(plan.graphics.filter(graphic => graphic.kind === 'subtitle')).toHaveLength(plan.captions.length)
  })

  it('uses source audio metadata for linked source placements', () => {
    const project = makeProject()
    project.video.hasAudio = false
    expect(buildFilmcraftPlan(project, makeClip()).placements
      .filter(placement => placement.track === 'V1')
      .every(placement => placement.audio === false)).toBe(true)
  })

  it('warns and falls back when sequence metadata cannot map', () => {
    const project = makeProject()
    project.video = { ...project.video, path: '', width: 0, height: 0, fps: 0 }
    const plan = buildFilmcraftPlan(project, makeClip('original'))
    expect(plan.sequence).toMatchObject({ width: 1920, height: 1080, fps: 30 })
    expect(plan.warnings.join(' ')).toContain('unmappable')
    expect(plan.warnings.join(' ')).toContain('word-level caption highlights')
    expect(plan.warnings.join(' ')).toContain('compositing can differ')
    expect(plan.manifest).toMatchObject({
      bridgeVersion: 1, projectId: project.id, clipId: 'clip-1',
      video: project.video, transcript: project.transcript, project
    })
  })
})
