import { randomBytes } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilmcraftControl } from '../src/main/filmcraftControl'
import { assertSupportedFilmcraftVersion, captionTrackStyle, graphicBox, openInFilmcraft, populateFilmcraft, resolveFilmcraftFont, writeFilmcraftManifest } from '../src/main/filmcraftBridge'
import { saveProject } from '../src/main/projects'
import { buildFilmcraftPlan } from '../src/shared/filmcraftPlan'
import type { Project } from '../src/shared/types'
import type { FilmcraftPlan } from '../src/shared/filmcraftPlan'

const mock = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mock.root } }))

const cleanup: string[] = []

function plan(): FilmcraftPlan {
  return {
    sequence: { name: 'Handoff', width: 1080, height: 1920, fps: 30 },
    mediaPaths: ['C:/media/source.mp4'],
    placements: [{ path: 'C:/media/source.mp4', track: 'V1', seconds: 0, sourceIn: 2, duration: 3, video: true, audio: true }],
    captions: [{ text: 'Caption', seconds: 0, durationSeconds: 1 }],
    graphics: [{ text: 'Hook', seconds: 0, durationSeconds: 1, position: [.5, .1], size: .05, kind: 'hook' }],
    warnings: ['Plan warning'],
    manifest: {
      bridgeVersion: 1, projectId: 'project-1', clipId: 'clip-1',
      video: { path: 'C:/media/source.mp4', fileName: 'source.mp4', durationSec: 3, width: 1920, height: 1080, fps: 30, sizeBytes: 1, hasAudio: true },
      transcript: null,
      clip: {} as FilmcraftPlan['manifest']['clip'],
      mapping: [{ sourceStart: 2, sourceEnd: 5, seconds: 0, duration: 3 }],
      unsupportedFeatures: []
    }
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (!address || typeof address === 'string') throw new Error('No loopback port')
  return address.port
}

async function launch(executable: string, args: string[], token: string): Promise<{ child: ChildProcess; control: FilmcraftControl }> {
  const child = spawn(executable, args, { env: { ...process.env, FILMCRAFT_CONTROL_TOKEN: token }, stdio: 'ignore' })
  const controlPort = Number(args[args.indexOf('--control') + 1])
  let last: unknown
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return { child, control: await FilmcraftControl.connect({ port: controlPort, token, timeoutMs: 500, requestTimeoutMs: 15_000 }) }
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  await stop(child)
  throw last instanceof Error ? last : new Error('Filmcraft control did not open')
}

function token(): string {
  return randomBytes(32).toString('hex')
}

function progress(message: string): void {
  if (process.env.FILMCRAFT_REAL_DEBUG === '1') console.error(message)
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit').then(() => undefined)
  child.kill()
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))])
  if (child.exitCode !== null || !child.pid) return
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } catch {
    // The process can exit between the check and taskkill.
  }
}

describe('Filmcraft control bridge', () => {
  it('sends authenticated JSON-lines requests to a loopback control server', async () => {
    const token = 'private-token'
    let peer: import('node:net').Socket | undefined
    const server = createServer(socket => {
      peer = socket
      socket.setEncoding('utf8')
      socket.on('data', (line: string) => {
        const request = JSON.parse(line) as { id: number; token: string; method: string; params: { command: string } }
        expect(request.token).toBe(token)
        expect(request.method).toBe('engine.execute')
        expect(request.params.command).toBe('file.saveAs')
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { saved: true } })}\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No loopback port')
    const control = await FilmcraftControl.connect({ port: address.port, token, timeoutMs: 1_000 })
    await expect(control.execute('file.saveAs', { path: 'C:/handoff.fcproj' })).resolves.toEqual({ saved: true })
    control.close()
    peer?.destroy()
    server.close()
  })

  it('writes complete handoff metadata without project schema generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cutawan-filmcraft-'))
    cleanup.push(directory)
    const manifestPath = join(directory, 'handoff.manifest.json')
    await writeFilmcraftManifest(manifestPath, plan())
    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as { sequence: FilmcraftPlan['sequence']; manifest: FilmcraftPlan['manifest']; placements: FilmcraftPlan['placements'] }
    expect(saved.sequence).toEqual(plan().sequence)
    expect(saved.placements).toEqual(plan().placements)
    expect(saved.manifest).toEqual(plan().manifest)
  })

  it('resolves Cutawan font names against installed Filmcraft fonts', () => {
    const installed = [{ family: 'Arial', styles: ['Regular', 'Bold'] }, { family: 'Poppins', styles: ['Regular', 'Medium'] }]
    expect(resolveFilmcraftFont('arial', installed)).toEqual({ font: 'Arial', missing: false })
    expect(resolveFilmcraftFont('Poppins Medium', installed)).toEqual({ font: 'Poppins', fontStyle: 'Medium', missing: false })
    expect(resolveFilmcraftFont('Anton', installed)).toMatchObject({ font: 'Anton', missing: true })
    expect(resolveFilmcraftFont('Poppins Medium', null)).toEqual({ font: 'Poppins', fontStyle: 'Medium', missing: true })
  })

  it('gates Filmcraft versions to 0.9.x', () => {
    expect(() => assertSupportedFilmcraftVersion('0.9.0', 'f.exe')).not.toThrow()
    expect(() => assertSupportedFilmcraftVersion('0.9.3', 'f.exe')).not.toThrow()
    for (const version of ['0.8.9', '0.10.0', '1.0.0']) {
      expect(() => assertSupportedFilmcraftVersion(version, 'f.exe')).toThrow(`Filmcraft ${version} at f.exe is not supported. Cutawan supports Filmcraft 0.9.x (>=0.9.0 <0.10.0).`)
    }
    for (const version of [null, 'garbage']) {
      expect(() => assertSupportedFilmcraftVersion(version, 'f.exe')).toThrow('Could not read the Filmcraft version of f.exe. Cutawan supports Filmcraft 0.9.x.')
    }
  })

  it('adds a slack line to the graphic box and keeps it centered', () => {
    const graphic = { text: 'a\nb', seconds: 0, durationSeconds: 1, position: [540, 800], size: 80, width: 860, kind: 'hook' } as FilmcraftPlan['graphics'][number]
    expect(graphicBox(graphic, 1)).toEqual({ position: [110, 620], box: [860, 360] })
    expect(graphicBox(graphic)).toEqual({ position: [110, 680], box: [860, 240] })
  })
  it('maps a subtitle graphic to caption track style anchored to the nearest edge', () => {
    const sequence = { name: 'S', width: 1080, height: 1920, fps: 30 }
    const subtitle = { text: 'a\nb', seconds: 0, durationSeconds: 1, position: [540, 1500], size: 80, width: 860, kind: 'subtitle', font: 'Anton', alignment: 'center', color: '#FFF', backgroundColor: '#112233', backgroundOpacity: .5, strokeColor: '#000000', strokeWidth: 4 } as FilmcraftPlan['graphics'][number]
    expect(captionTrackStyle(subtitle, sequence, { font: 'Anton', missing: true })).toEqual({
      size: 80, anchor: 'bottom', margin: (1920 - 1500 - 120) / 1920, font: 'Anton', align: 'center', color: '#ffffff',
      background: true, backgroundColor: '#11223380', outline: 4, outlineColor: '#000000'
    })
    expect(captionTrackStyle({ ...subtitle, position: [540, 400], backgroundColor: undefined, backgroundOpacity: undefined }, sequence)).toEqual({
      size: 80, anchor: 'top', margin: (400 - 120) / 1920, align: 'center', color: '#ffffff', outline: 4, outlineColor: '#000000'
    })
    expect(captionTrackStyle({ ...subtitle, position: [540, 1900] }, sequence)).toMatchObject({ anchor: 'bottom', margin: 0 })
    expect(captionTrackStyle({ ...subtitle, position: [540, 501], size: 1, width: 10 }, { ...sequence, height: 1000 })).toMatchObject({ anchor: 'bottom', margin: .45 })
  })

  it('states that Filmcraft shows a substitute font while the requested font stays in the project', async () => {
    const calls: Array<{ command: string; params: Record<string, unknown> }> = []
    const control = {
      request: async () => ['file.import', 'file.newSequence', 'timeline.place', 'file.saveAs', 'graphics.newText', 'graphics.set', 'fonts.list', 'captions.newTrack', 'captions.add', 'captions.setTrack', 'captions.setStyle'].map(id => ({ id })),
      execute: async (command: string, params: Record<string, unknown>) => {
        calls.push({ command, params })
        if (command === 'file.import') return { items: [1], errors: [] }
        if (command === 'captions.newTrack') return { track: 7 }
        if (command === 'graphics.newText') return { clip: 1, layer: 0 }
        if (command === 'fonts.list') return [{ family: 'Arial', styles: ['Regular'] }]
        return {}
      }
    } as unknown as FilmcraftControl
    const base = plan()
    const fontPlan: FilmcraftPlan = {
      ...base,
      graphics: [
        { ...base.graphics[0], font: 'Anton' },
        { text: 'Caption', seconds: 0, durationSeconds: 1, position: [540, 1600], size: 60, width: 800, kind: 'subtitle', font: 'Anton' }
      ]
    }
    const warnings: string[] = []
    await populateFilmcraft(control, fontPlan, 'C:/p.fcproj', warnings)
    expect(warnings).toContain('Font "Anton" (hook, subtitle) is not installed for Filmcraft. The project keeps "Anton", but Filmcraft displays a substitute font until it is installed, so text may wrap differently inside the generated text box. Install "Anton" or choose another font in Filmcraft.')
    expect(warnings).toContain('Editable captions are also on the disabled "Cutawan captions" track; enable it in Filmcraft to use track captions instead of the subtitle graphics.')
    expect(calls.filter(call => call.command === 'graphics.newText').map(call => call.params.font)).toEqual(['Anton', 'Anton'])
    expect(calls.find(call => call.command === 'captions.setStyle')?.params).toMatchObject({ track: 7, font: 'Anton' })
    expect(calls.find(call => call.command === 'captions.setTrack')?.params).toEqual({ track: 7, enabled: false })
    expect(calls.findIndex(call => call.command === 'captions.setStyle')).toBeLessThan(calls.findIndex(call => call.command === 'captions.setTrack'))

    calls.length = 0
    const unverified: string[] = []
    const noFonts = { ...control, request: async () => ['file.import', 'file.newSequence', 'timeline.place', 'file.saveAs', 'graphics.newText'].map(id => ({ id })), execute: control.execute } as unknown as FilmcraftControl
    await populateFilmcraft(noFonts, fontPlan, 'C:/p.fcproj', unverified)
    expect(unverified.some(warning => warning.includes('could not verify') && warning.includes('displays a substitute font'))).toBe(true)
    expect(unverified.some(warning => warning.includes('only added as subtitle graphics'))).toBe(true)
    expect(calls.some(call => call.command.startsWith('captions.'))).toBe(false)
  })
  it.runIf(process.env.FILMCRAFT_REAL_TEST === '1')('imports linked media, styles editable graphics, saves, and reopens all aspect ratios', async () => {
    const executable = process.env.FILMCRAFT_EXE ?? 'D:/Downloads/Other/filmcraft-0.9.0-windows-x64-portable/filmcraft.exe'
    const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
    expect(existsSync(executable), `Filmcraft executable missing: ${executable}`).toBe(true)
    expect(existsSync(ffmpeg), `ffmpeg missing: ${ffmpeg}`).toBe(true)
    const directory = await mkdtemp(join(tmpdir(), 'cutawan-filmcraft-real-'))
    cleanup.push(directory)
    const media = join(directory, 'source.mp4')
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', media], { stdio: 'ignore' })
    for (const [width, height] of [[1080, 1920], [1080, 1080], [1920, 1080]]) {
      progress(`start ${width}x${height}`)
      const controlPort = await port()
      const firstToken = token()
      const { child, control } = await launch(executable, ['--control', String(controlPort), '--empty', '--no-recover', '--graphics', 'software', '--data-dir', join(directory, `data-${width}x${height}`)], firstToken)
      const projectPath = join(directory, `${width}x${height}.fcproj`)
      try {
        progress(`import ${width}x${height}`)
        const imported = await control.execute('file.import', { paths: [media] }) as { items: number[]; errors: string[] }
        expect(imported.errors).toEqual([])
        expect(imported.items).toHaveLength(1)
        progress(`sequence ${width}x${height}`)
        await control.execute('file.newSequence', { name: `Probe ${width}x${height}`, width, height, fps: 30, video: 3, audio: 1 })
        progress(`placement ${width}x${height}`)
        await control.execute('timeline.place', { item: imported.items[0], track: 'V1', audioTrack: 'A1', time: 0, sourceIn: 0, duration: 508032000000, video: true, audio: true })
        progress(`captions ${width}x${height}`)
        const captions = await control.execute('captions.newTrack', { format: 'Subtitle', name: 'Cutawan captions' }) as { track: number }
        expect(captions.track).toEqual(expect.any(Number))
        const caption = await control.execute('captions.add', { track: captions.track, text: 'Editable caption', time: 0, durationSeconds: 1 }) as { caption: number }
        expect(caption.caption).toEqual(expect.any(Number))
        progress(`graphics ${width}x${height}`)
        const graphic = await control.execute('graphics.newText', { text: 'Editable hook', position: [120, 180], box: [720, 200], size: 88, seconds: 1, track: 2, time: 0 }) as { clip: number; layer: number }
        expect(graphic).toMatchObject({ clip: expect.any(Number), layer: 0 })
        await control.execute('graphics.set', { clip: graphic.clip, layer: graphic.layer, time: 0, props: { position: [120, 180], size: 88, align: 'center', fill_color: '#ffee00', background: true, background_color: '#000000', background_opacity: 65, stroke: true, stroke_color: '#112233', stroke_width: 4, shadow: true, shadow_distance: 6 } })
        progress(`save ${width}x${height}`)
        await control.execute('file.saveAs', { path: projectPath })
      } finally {
        control.close()
        await stop(child)
      }
      progress(`inspect ${width}x${height}`)
      const saved = await readFile(projectPath, 'utf8')
      expect(saved).toContain(`"width":${width}`)
      expect(saved).toContain(`"height":${height}`)
      expect(saved).toContain('Editable caption')
      expect(saved).toContain('Editable hook')
      progress(`reopen ${width}x${height}`)
      const reopenPort = await port()
      const reopenToken = token()
      const reopened = await launch(executable, ['--control', String(reopenPort), projectPath, '--no-recover', '--graphics', 'software', '--data-dir', join(directory, `reopen-${width}x${height}`)], reopenToken)
      try {
        const inspection = await reopened.control.execute('sequence.inspect') as { settings?: { width?: number; height?: number } }
        expect(inspection.settings).toMatchObject({ width, height })
      } finally {
        reopened.control.close()
        await stop(reopened.child)
      }
    }
  }, 120_000)

  it.runIf(process.env.FILMCRAFT_REAL_TEST === '1')('hands a real Cutawan clip to Filmcraft with editable captions and a sized hook box', async () => {
    const executable = process.env.FILMCRAFT_EXE ?? 'D:/Downloads/Other/filmcraft-0.9.0-windows-x64-portable/filmcraft.exe'
    const ffmpeg = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
    expect(existsSync(executable), `Filmcraft executable missing: ${executable}`).toBe(true)
    expect(existsSync(ffmpeg), `ffmpeg missing: ${ffmpeg}`).toBe(true)
    const keep = Boolean(process.env.FILMCRAFT_KEEP)
    mock.root = await mkdtemp(join(tmpdir(), 'cutawan-handoff-e2e-'))
    cleanup.push(mock.root)
    const mediaDirectory = await mkdtemp(join(tmpdir(), 'cutawan-handoff-media-'))
    if (!keep) cleanup.push(mediaDirectory)
    const media = join(mediaDirectory, 'source.mp4')
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', media], { stdio: 'ignore' })
    const project: Project = {
      id: 'handoff-e2e', createdAt: 0, updatedAt: 0, name: 'Handoff e2e',
      video: { path: media, fileName: 'source.mp4', durationSec: 4, width: 640, height: 360, fps: 30, sizeBytes: 1, hasAudio: true },
      transcript: {
        language: 'en', durationSec: 4,
        segments: [{
          id: 0, text: 'hello brave new world', start: 0, end: 4,
          words: [
            { text: 'hello', start: 0, end: 0.8 },
            { text: 'brave', start: 1, end: 1.8 },
            { text: 'new', start: 2, end: 2.8 },
            { text: 'world', start: 3, end: 3.8 }
          ]
        }]
      },
      clips: [{
        id: 'clip-1', suggestedStart: 0, suggestedEnd: 4, title: 'Handoff clip',
        hook: 'This hook is long enough to wrap onto two lines', summary: '', caption: null, viralityScore: 0,
        viralityReason: '', visualSummary: null, hashtags: [], thumbnailPath: null, focusTrack: null, broll: [],
        edit: {
          aspect: '9:16', reframeMode: 'crop', framing: 'auto', tightenCuts: false,
          focusX: .5, captionsEnabled: true, captionStyleId: 'beast', showTitle: true,
          start: 0, end: 4, cuts: [], hookDuration: 3
        }
      }],
      prompt: '', videoType: 'auto'
    }
    await saveProject(project)
    const hook = buildFilmcraftPlan(project, project.clips[0]).graphics.find(graphic => graphic.kind === 'hook')
    expect(hook).toBeDefined()
    const hookLineCount = hook!.text.split('\n').length

    const tasklist = (): number[] => {
      try {
        return execFileSync('tasklist', ['/FI', 'IMAGENAME eq filmcraft.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
          .split(/\r?\n/).map(line => Number(line.split('","')[1])).filter(pid => Number.isInteger(pid) && pid > 0)
      } catch {
        return []
      }
    }
    const before = new Set(tasklist())
    let result: Awaited<ReturnType<typeof openInFilmcraft>>
    try {
      result = await openInFilmcraft(project.id, 'clip-1', executable)
    } finally {
      for (const pid of tasklist().filter(candidate => !before.has(candidate))) {
        try {
          execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
        } catch {
          // The process can exit between listing and taskkill.
        }
      }
    }
    progress(`warnings ${JSON.stringify(result.warnings)}`)
    expect(existsSync(result.projectPath)).toBe(true)
    expect(existsSync(result.manifestPath)).toBe(true)
    if (keep) copyFileSync(result.projectPath, join(tmpdir(), 'cutawan-handoff-e2e.fcproj'))
    const saved = await readFile(result.projectPath, 'utf8')
    expect(saved).toContain('"width":1080')
    expect(saved).toContain('"height":1920')
    expect(saved).toContain(JSON.stringify(hook!.text).slice(1, -1))
    expect(saved).toContain('hello')
    expect(result.warnings.some(warning => /font/i.test(warning) && warning.includes('text box'))).toBe(true)

    const boxes: Record<string, unknown>[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (!value || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      if (record.effect === 'graphic_text' && record.params && typeof record.params === 'object') boxes.push(record.params as Record<string, unknown>)
      Object.values(record).forEach(walk)
    }
    walk(JSON.parse(saved))
    const params = boxes.find(candidate => JSON.stringify(candidate).includes(JSON.stringify(hook!.text).slice(1, -1)))
    expect(params, 'hook graphic_text params').toBeDefined()
    progress(`hook params ${JSON.stringify(params)}`)
    const scalar = (name: string): number => Number(Object.values((params![name] as { value: Record<string, unknown> }).value)[0])
    const size = scalar('size')
    expect(size).toBeGreaterThan(0)
    expect(scalar('box_width')).toBeGreaterThan(0)
    expect(scalar('box_height')).toBeCloseTo(size * 1.5 * (hookLineCount + 1), 1)

    const document = JSON.parse(saved) as unknown
    const captionTracks: Array<Record<string, unknown>> = []
    const findTracks = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(findTracks)
      if (!value || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      if (Array.isArray(record.caption_tracks)) captionTracks.push(...record.caption_tracks as Array<Record<string, unknown>>)
      Object.values(record).forEach(findTracks)
    }
    findTracks(document)
    const captionTrack = captionTracks.find(track => track.name === 'Cutawan captions')
    expect(captionTrack, 'Cutawan captions track').toBeDefined()
    expect(captionTrack!.enabled).toBe(false)
    expect((captionTrack!.captions as unknown[]).length).toBeGreaterThan(0)
    expect(captionTrack!.style).toMatchObject({ font: 'Anton', anchor: 'Bottom' })
    expect(result.warnings.some(warning => warning.includes('disabled "Cutawan captions" track'))).toBe(true)
    expect(result.warnings.some(warning => warning.includes('The project keeps "Anton"'))).toBe(true)
    const fontValues = [...saved.matchAll(/"font":\{"value":\{"Text":"([^"]*)"\}\}/g)].map(match => match[1])
    expect(fontValues.length).toBeGreaterThan(0)
    expect(new Set(fontValues)).toEqual(new Set(['Anton']))

    const cli = join(dirname(executable), 'filmcraft-cli.exe')
    expect(existsSync(cli), `filmcraft-cli missing: ${cli}`).toBe(true)
    const frame = 'C:/Users/muradik/Documents/Codex/2026-10-24/d-downloads-cutawan-main-zip/outputs/filmcraft-handoff-frame.png'
    mkdirSync(dirname(frame), { recursive: true })
    execFileSync(cli, ['--project', result.projectPath, 'render', '--seconds', '0.5', '--out', frame], { stdio: 'ignore', timeout: 60_000 })
    expect(statSync(frame).size).toBeGreaterThan(1_000)  }, 120_000)
})