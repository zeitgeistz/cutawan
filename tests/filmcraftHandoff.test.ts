import { describe, expect, it } from 'vitest'
import { handoffToFilmcraft } from '../src/renderer/src/filmcraftHandoff'
import type { Clip } from '@shared/types'

const clipWith = (caption: string, x: number): Clip => ({ id: 'c1', caption, overlay: { x, y: 0.2 } }) as unknown as Clip

function setup() {
  const calls: string[] = []
  let stored = clipWith('old', 0.5)
  const saved: Clip[] = []
  const options = {
    projectId: 'p1',
    clipId: 'c1',
    executablePath: 'fc.exe',
    inFlight: { current: false },
    blurActive: () => {
      calls.push('blur')
      stored = clipWith('new caption', 0.1)
    },
    latestClip: () => stored,
    saveClip: async (_id: string, clip: Clip) => {
      calls.push('save')
      saved.push(clip)
    },
    open: async (_p: string, _c: string, exe?: string) => {
      calls.push(`open:${exe}`)
      return { projectPath: 'x' }
    }
  }
  return { calls, saved, options }
}

describe('handoffToFilmcraft', () => {
  it('blurs, saves the clip read after blur, then opens', async () => {
    const { calls, saved, options } = setup()
    const result = await handoffToFilmcraft(options)
    expect(calls).toEqual(['blur', 'save', 'open:fc.exe'])
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ caption: 'new caption', overlay: { x: 0.1 } })
    expect(result).toEqual({ projectPath: 'x' })
    expect(options.inFlight.current).toBe(false)
  })

  it('saves the clip with the style preset applied, keeping trim and cuts', async () => {
    const { calls, saved, options } = setup()
    const base = { start: 5, end: 25, aspect: '9:16', captionStyleId: 'beast', showTitle: false, cuts: [{ start: 6, end: 7 }] }
    options.latestClip = () => ({ id: 'c1', edit: base }) as unknown as Clip
    const result = await handoffToFilmcraft({ ...options, stylePreset: { aspect: '1:1', captionStyleId: 'clean', showTitle: true } })
    expect(calls).toEqual(['blur', 'save', 'open:fc.exe'])
    expect(result).toEqual({ projectPath: 'x' })
    expect(saved[0].edit).toMatchObject({
      aspect: '1:1', captionStyleId: 'clean', showTitle: true, start: 5, end: 25, cuts: [{ start: 6, end: 7 }]
    })
    expect(base.aspect).toBe('9:16')
  })

  it('saves the clip unchanged without a preset', async () => {
    const { saved, options } = setup()
    await handoffToFilmcraft(options)
    expect(saved[0]).toMatchObject({ caption: 'new caption' })
    expect(saved[0]).not.toHaveProperty('edit')
  })
  it('does not open when save fails and surfaces the error', async () => {
    const { calls, options } = setup()
    options.saveClip = async () => {
      calls.push('save')
      throw new Error('disk full')
    }
    await expect(handoffToFilmcraft(options)).rejects.toThrow(/disk full/)
    expect(calls).toEqual(['blur', 'save'])
    expect(options.inFlight.current).toBe(false)
  })

  it('ignores a second call while the first is pending', async () => {
    const { calls, options } = setup()
    const first = handoffToFilmcraft(options)
    const second = await handoffToFilmcraft(options)
    expect(second).toBeNull()
    await first
    expect(calls).toEqual(['blur', 'save', 'open:fc.exe'])
  })
})
