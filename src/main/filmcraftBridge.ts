import { app } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { buildFilmcraftPlan, type FilmcraftPlan } from '@shared/filmcraftPlan'
import { loadProject, projectDir } from './projects'
import { FilmcraftControl } from './filmcraftControl'

const TICKS_PER_SECOND = 254_016_000_000
const CONTROL_CONNECT_TIMEOUT_MS = 15_000
const execFileAsync = promisify(execFile)

export const SUPPORTED_FILMCRAFT_RANGE = { min: '0.9.0', maxExclusive: '0.10.0' }

interface FilmcraftSettings {
  selectedExecutable?: string
}

interface HandoffPaths {
  directory: string
  projectPath: string
  manifestPath: string
}

interface CommandInfo {
  id?: unknown
}

function settingsPath(): string | null {
  const userData = app?.getPath('userData')
  return userData ? join(userData, 'filmcraft-settings.json') : null
}

function isExecutable(path: string): boolean {
  return path.toLowerCase().endsWith('.exe') && existsSync(path)
}

async function readSettings(): Promise<FilmcraftSettings> {
  const path = settingsPath()
  if (!path) return {}
  try {
    return JSON.parse(await readFile(path, 'utf8')) as FilmcraftSettings
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return {}
  }
}

function writeSettings(settings: FilmcraftSettings): void {
  const path = settingsPath()
  if (!path) return
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(settings), 'utf8')
}

function executableCandidates(): string[] {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
    process.env.APPDATA
  ].filter((value): value is string => Boolean(value))
  const candidates = [
    join('D:', 'Downloads', 'filmcraft-0.9.0-windows-x64-portable', 'filmcraft.exe'),
    join('D:', 'Downloads', 'Other', 'filmcraft-0.9.0-windows-x64-portable', 'filmcraft.exe')
  ]
  for (const root of roots) {
    candidates.push(
      join(root, 'Filmcraft', 'filmcraft.exe'),
      join(root, 'FilmCraft', 'FilmCraft.exe'),
      join(root, 'Programs', 'Filmcraft', 'filmcraft.exe'),
      join(root, 'Programs', 'FilmCraft', 'FilmCraft.exe')
    )
  }
  return candidates
}

export async function findFilmcraftExecutables(): Promise<string[]> {
  const settings = await readSettings()
  const candidates = [settings.selectedExecutable, ...executableCandidates()].filter((path): path is string => Boolean(path))
  return [...new Set(candidates.map(path => resolve(path)).filter(isExecutable))]
}

export function getSelectedFilmcraftExecutable(): string | null {
  const path = settingsPath()
  if (!path) return null
  try {
    const selected = (JSON.parse(readFileSync(path, 'utf8')) as FilmcraftSettings).selectedExecutable
    return selected && isExecutable(selected) ? resolve(selected) : null
  } catch {
    return null
  }
}

export function setSelectedFilmcraftExecutable(path: string): void {
  if (!isExecutable(path)) throw new Error(`Filmcraft executable was not found: ${path}`)
  writeSettings({ selectedExecutable: resolve(path) })
}

async function unusedHandoffPaths(directory: string, base: string): Promise<HandoffPaths> {
  await mkdir(directory, { recursive: true })
  for (let index = 1; ; index++) {
    const suffix = index === 1 ? '' : `-${index}`
    const projectPath = join(directory, `${base}${suffix}.fcproj`)
    const manifestPath = join(directory, `${base}${suffix}.manifest.json`)
    if (!existsSync(projectPath) && !existsSync(manifestPath)) return { directory, projectPath, manifestPath }
  }
}

function handoffName(clipId: string): string {
  return `filmcraft-${clipId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export async function writeFilmcraftManifest(path: string, plan: FilmcraftPlan): Promise<void> {
  await writeFile(path, JSON.stringify({
    bridgeVersion: 1,
    generatedAt: new Date().toISOString(),
    sequence: plan.sequence,
    mediaPaths: plan.mediaPaths,
    placements: plan.placements,
    captions: plan.captions,
    graphics: plan.graphics,
    warnings: plan.warnings,
    manifest: plan.manifest
  }, null, 2), 'utf8')
}

async function reserveControlPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise)
  })
  const address = server.address()
  await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()))
  if (!address || typeof address === 'string') throw new Error('Could not reserve a Filmcraft control port.')
  return address.port
}

async function connectWhenReady(port: number, token: string): Promise<FilmcraftControl> {
  const deadline = Date.now() + CONTROL_CONNECT_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await FilmcraftControl.connect({ port, token, timeoutMs: 1_000, requestTimeoutMs: 30_000 })
    } catch (error) {
      lastError = error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : ''
  throw new Error(`Filmcraft did not open its control channel within ${CONTROL_CONNECT_TIMEOUT_MS}ms.${detail}`)
}

function commandIds(result: unknown): Set<string> {
  const commands = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { commands?: unknown }).commands)
      ? (result as { commands: unknown[] }).commands
      : []
  return new Set(commands.map(command => (command as CommandInfo).id).filter((id): id is string => typeof id === 'string'))
}

function requireCommands(available: Set<string>, names: string[]): void {
  const missing = names.filter(name => !available.has(name))
  if (missing.length) throw new Error(`This Filmcraft version lacks required control commands: ${missing.join(', ')}. Update Filmcraft and try again.`)
}

function ticks(seconds: number, fps: number, warnings: string[]): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Invalid Filmcraft timeline time: ${seconds}`)
  const frames = Math.round(seconds * fps)
  const value = Math.round(frames * (TICKS_PER_SECOND / fps))
  if (!Number.isSafeInteger(value)) {
    throw new Error('This handoff exceeds JavaScript-safe Filmcraft tick precision. Split the clip into a shorter handoff.')
  }
  const alignedSeconds = frames / fps
  if (Math.abs(alignedSeconds - seconds) > 0.0001) {
    warnings.push(`Filmcraft time ${seconds.toFixed(6)}s was aligned to frame ${frames} at ${fps} fps.`)
  }
  return value
}

function validatePlanMedia(plan: FilmcraftPlan): void {
  const missing = plan.mediaPaths.filter(path => !existsSync(path))
  if (missing.length) {
    throw new Error(`Filmcraft cannot import missing media: ${missing.join('; ')}. Relink the source or B-roll in Cutawan, then try again.`)
  }
}

function importedMedia(result: unknown, expected: number): number[] {
  if (!result || typeof result !== 'object') throw new Error('Filmcraft returned no media-import result.')
  const reply = result as { items?: unknown; errors?: unknown }
  const errors = Array.isArray(reply.errors) ? reply.errors.filter((value): value is string => typeof value === 'string' && value.length > 0) : []
  const items = Array.isArray(reply.items) ? reply.items : []
  if (errors.length || items.length !== expected || !items.every(item => typeof item === 'number')) {
    const detail = errors.length ? ` ${errors.join('; ')}` : ''
    throw new Error(`Filmcraft did not import one usable media item per handoff path.${detail}`)
  }
  return items as number[]
}

function graphicTrackIndexes(plan: FilmcraftPlan): number[] {
  const tracks: Array<Array<{ start: number; end: number }>> = []
  return plan.graphics.map(graphic => {
    const interval = { start: graphic.seconds, end: graphic.seconds + graphic.durationSeconds }
    let index = tracks.findIndex(track => track.every(used => interval.end <= used.start || interval.start >= used.end))
    if (index < 0) {
      index = tracks.length
      tracks.push([])
    }
    tracks[index].push(interval)
    return index + 2
  })
}

/** Cutawan positions are the text-box center; Filmcraft places a paragraph box by its top-left corner. */
export function graphicBox(graphic: FilmcraftPlan['graphics'][number], extraLines = 0): { position: [number, number]; box?: [number, number] } {
  const size = Math.max(1, graphic.size)
  const slack = size * 1.5 * Math.max(0, extraLines)
  const base: [number, number] | undefined = graphic.width !== undefined
    ? [Math.max(1, graphic.width), size * 1.5 * Math.max(1, graphic.text.split('\n').length)]
    : graphic.box
  const box: [number, number] | undefined = base && [base[0], base[1] + slack]
  if (!box) return { position: graphic.position }
  return { position: [graphic.position[0] - box[0] / 2, graphic.position[1] - box[1] / 2], box }
}

function graphicStyleProps(graphic: FilmcraftPlan['graphics'][number], font?: ResolvedFont, extraLines = 0): Record<string, unknown> {
  const props: Record<string, unknown> = { position: graphicBox(graphic, extraLines).position, size: Math.max(1, graphic.size) }
  if (font) {
    props.font = font.font
    if (font.fontStyle) props.font_style = font.fontStyle
  }
  if (graphic.alignment) props.align = graphic.alignment
  if (graphic.color) props.fill_color = graphic.color
  if (graphic.backgroundColor || graphic.backgroundOpacity !== undefined) props.background = true
  if (graphic.backgroundColor) props.background_color = graphic.backgroundColor
  if (graphic.backgroundOpacity !== undefined) props.background_opacity = Math.min(100, Math.max(0, graphic.backgroundOpacity * 100))
  if (graphic.strokeColor) {
    props.stroke = true
    props.stroke_color = graphic.strokeColor
  }
  if (graphic.strokeWidth !== undefined) props.stroke_width = Math.max(0, graphic.strokeWidth)
  if (graphic.shadow !== undefined) {
    props.shadow = graphic.shadow > 0
    props.shadow_distance = Math.max(0, graphic.shadow)
  }
  return props
}

export interface InstalledFont {
  family: string
  styles: string[]
}

export interface ResolvedFont {
  font: string
  fontStyle?: string
  missing: boolean
}

const STYLE_WORDS = new Set(['thin', 'extralight', 'light', 'regular', 'medium', 'semibold', 'bold', 'extrabold', 'black', 'italic'])

function splitStyle(name: string): { prefix: string; style: string } | null {
  const words = name.trim().split(/\s+/)
  for (const count of [2, 1]) {
    if (words.length <= count) continue
    const tail = words.slice(-count)
    if (tail.every(word => STYLE_WORDS.has(word.toLowerCase()))) return { prefix: words.slice(0, -count).join(' '), style: tail.join(' ') }
  }
  return null
}

/** Maps a Cutawan font name ("Poppins Medium") to a Filmcraft family and style. */
export function resolveFilmcraftFont(name: string, installed: InstalledFont[] | null): ResolvedFont {
  const lower = name.trim().toLowerCase()
  if (installed) {
    const exact = installed.find(entry => entry.family.toLowerCase() === lower)
    if (exact) return { font: exact.family, missing: false }
    const squash = (value: string): string => value.toLowerCase().replace(/\s+/g, '')
    const families = [...installed].sort((a, b) => b.family.length - a.family.length)
    for (const entry of families) {
      const family = entry.family.toLowerCase()
      if (!lower.startsWith(`${family} `)) continue
      const rest = squash(lower.slice(family.length))
      const style = entry.styles.find(candidate => squash(candidate) === rest)
      if (style) return { font: entry.family, fontStyle: style, missing: false }
    }
  }
  const split = splitStyle(name)
  return split ? { font: split.prefix, fontStyle: split.style, missing: true } : { font: name, missing: true }
}

async function fetchInstalledFonts(control: FilmcraftControl, available: Set<string>): Promise<InstalledFont[] | null> {
  if (!available.has('fonts.list')) return null
  try {
    const result = await control.execute('fonts.list', { system: true })
    if (!Array.isArray(result)) return null
    const fonts: InstalledFont[] = []
    for (const entry of result) {
      const { family, styles } = (entry && typeof entry === 'object' ? entry : {}) as { family?: unknown; styles?: unknown }
      if (typeof family !== 'string') continue
      fonts.push({ family, styles: Array.isArray(styles) ? styles.filter((style): style is string => typeof style === 'string') : [] })
    }
    return fonts
  } catch {
    return null
  }
}

function hexColor(value: string | undefined, opacity?: number): string | undefined {
  const match = value && /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())
  if (!match) return undefined
  let hex = match[1].toLowerCase()
  if (hex.length === 3) hex = [...hex].map(char => char + char).join('')
  if (opacity === undefined) return `#${hex}`
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255).toString(16).padStart(2, '0')
  return `#${hex.slice(0, 6)}${alpha}`
}

/** Maps a subtitle graphic to captions.setStyle params so the disabled caption track matches the graphics. */
export function captionTrackStyle(graphic: FilmcraftPlan['graphics'][number], sequence: FilmcraftPlan['sequence'], font?: ResolvedFont): Record<string, unknown> {
  const height = Math.max(1, sequence.height)
  const size = Math.max(1, graphic.size)
  const boxHeight = graphicBox(graphic).box?.[1] ?? size * 1.5 * Math.max(1, graphic.text.split('\n').length)
  const centerY = graphic.position[1]
  const clamp = (value: number): number => Math.min(0.45, Math.max(0, value))
  const bottom = centerY > height / 2
  const style: Record<string, unknown> = {
    size,
    anchor: bottom ? 'bottom' : 'top',
    margin: clamp(bottom ? (height - centerY - boxHeight / 2) / height : (centerY - boxHeight / 2) / height)
  }
  if (font) style.font = font.font
  if (graphic.alignment) style.align = graphic.alignment
  const color = hexColor(graphic.color)
  if (color) style.color = color
  const background = hexColor(graphic.backgroundColor, graphic.backgroundOpacity ?? 1)
  if (background) {
    style.background = true
    style.backgroundColor = background
  }
  const outlineColor = hexColor(graphic.strokeColor)
  if (graphic.strokeWidth !== undefined && outlineColor) {
    style.outline = Math.max(0, graphic.strokeWidth)
    style.outlineColor = outlineColor
  }
  return style
}
function fontWarnings(plan: FilmcraftPlan, resolved: Map<string, ResolvedFont>, verified: boolean): string[] {
  const kinds = new Map<string, Set<string>>()
  for (const graphic of plan.graphics) {
    if (!graphic.font || !resolved.get(graphic.font)?.missing) continue
    const set = kinds.get(graphic.font) ?? new Set<string>()
    set.add(graphic.kind)
    kinds.set(graphic.font, set)
  }
  const tail = (font: string): string => `so text may wrap differently inside the generated text box. Install "${font}" or choose another font in Filmcraft.`
  return [...kinds].map(([font, set]) => verified
    ? `Font "${font}" (${[...set].join(', ')}) is not installed for Filmcraft. The project keeps "${font}", but Filmcraft displays a substitute font until it is installed, ${tail(font)}`
    : `Cutawan could not verify that font "${font}" (${[...set].join(', ')}) is installed for Filmcraft. The project keeps "${font}"; if it is missing, Filmcraft displays a substitute font until it is installed, ${tail(font)}`)
}

export function assertSupportedFilmcraftVersion(version: string | null, executable: string): void {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim().split(/[-+]/)[0])
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
  }
  const compare = (a: number[], b: number[]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const parsed = version === null ? null : parse(version)
  if (version === null || !parsed) throw new Error(`Could not read the Filmcraft version of ${executable}. Cutawan supports Filmcraft 0.9.x.`)
  if (compare(parsed, parse(SUPPORTED_FILMCRAFT_RANGE.min)!) < 0 || compare(parsed, parse(SUPPORTED_FILMCRAFT_RANGE.maxExclusive)!) >= 0) {
    throw new Error(`Filmcraft ${version} at ${executable} is not supported. Cutawan supports Filmcraft 0.9.x (>=0.9.0 <0.10.0). Install a supported version or choose another executable.`)
  }
}

async function readFilmcraftVersion(executable: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    // `-Command` does not bind trailing arguments to $args; pass the path through the environment.
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:CUTAWAN_FILMCRAFT_EXE).VersionInfo.ProductVersion'], {
      timeout: 10_000, windowsHide: true, env: { ...process.env, CUTAWAN_FILMCRAFT_EXE: executable }
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}
export async function populateFilmcraft(control: FilmcraftControl, plan: FilmcraftPlan, projectPath: string, warnings: string[]): Promise<void> {
  const available = commandIds(await control.request('engine.commands'))
  requireCommands(available, ['file.import', 'file.newSequence', 'timeline.place', 'file.saveAs'])
  const installedFonts = plan.graphics.some(graphic => graphic.font) ? await fetchInstalledFonts(control, available) : null
  const resolvedFonts = new Map<string, ResolvedFont>()
  for (const graphic of plan.graphics) {
    if (graphic.font && !resolvedFonts.has(graphic.font)) resolvedFonts.set(graphic.font, resolveFilmcraftFont(graphic.font, installedFonts))
  }
  warnings.push(...fontWarnings(plan, resolvedFonts, installedFonts !== null))
  const importResult = await control.execute('file.import', { paths: plan.mediaPaths })
  const imported = importedMedia(importResult, plan.mediaPaths.length)
  const itemsByPath = new Map(plan.mediaPaths.map((path, index) => [path, imported[index]]))
  const graphicTracks = graphicTrackIndexes(plan)
  await control.execute('file.newSequence', {
    name: plan.sequence.name || 'Cutawan handoff', width: Math.round(plan.sequence.width), height: Math.round(plan.sequence.height),
    fps: plan.sequence.fps, video: Math.max(3, 2 + plan.graphics.length), audio: 1
  })
  for (const placement of plan.placements) {
    const item = itemsByPath.get(placement.path)
    if (item === undefined) throw new Error(`Filmcraft import did not return media item for ${placement.path}.`)
    await control.execute('timeline.place', {
      item,
      track: placement.track,
      audioTrack: placement.audio ? 'A1' : undefined,
      time: ticks(placement.seconds, plan.sequence.fps, warnings),
      sourceIn: ticks(placement.sourceIn, plan.sequence.fps, warnings),
      duration: ticks(placement.duration, plan.sequence.fps, warnings),
      video: placement.video,
      audio: placement.audio
    })
  }
  if (plan.captions.length && available.has('captions.newTrack') && available.has('captions.add') && available.has('captions.setTrack')) {
    const captionTrack = await control.execute('captions.newTrack', { format: 'Subtitle', name: 'Cutawan captions' })
    const track = captionTrack && typeof captionTrack === 'object' ? (captionTrack as { track?: unknown }).track : undefined
    if (typeof track === 'number' || typeof track === 'string') {
      for (const caption of plan.captions) {
        await control.execute('captions.add', {
          track, text: caption.text, time: ticks(caption.seconds, plan.sequence.fps, warnings), durationSeconds: caption.durationSeconds
        })
      }
      const subtitle = plan.graphics.find(graphic => graphic.kind === 'subtitle')
      if (subtitle && available.has('captions.setStyle')) {
        const font = subtitle.font ? resolvedFonts.get(subtitle.font) : undefined
        await control.execute('captions.setStyle', { track, ...captionTrackStyle(subtitle, plan.sequence, font) })
      }
      await control.execute('captions.setTrack', { track, enabled: false })
      warnings.push('Editable captions are also on the disabled "Cutawan captions" track; enable it in Filmcraft to use track captions instead of the subtitle graphics.')
    } else {
      warnings.push('Filmcraft created no caption-track id; captions were not added as editable captions.')
    }
  } else if (plan.captions.length) {
    warnings.push('This Filmcraft version cannot disable caption tracks or add captions; captions were only added as subtitle graphics.')
  }  if (plan.graphics.length && available.has('graphics.newText')) {
    for (const [index, graphic] of plan.graphics.entries()) {
      const font = graphic.font ? resolvedFonts.get(graphic.font) : undefined
      const extraLines = font?.missing ? 1 : 0
      const params: Record<string, unknown> = {
        text: graphic.text,
        ...graphicBox(graphic, extraLines),
        size: Math.max(1, graphic.size),
        seconds: graphic.durationSeconds,
        track: graphicTracks[index],
        time: ticks(graphic.seconds, plan.sequence.fps, warnings)
      }
      if (font) {
        params.font = font.font
        if (font.fontStyle) params.fontStyle = font.fontStyle
      }
      if (graphic.width === undefined && graphic.box) {
        warnings.push(`${graphic.kind} uses deprecated graphic.box; width-based wrapping is preferred.`)
      }
      const created = await control.execute('graphics.newText', params)
      const reply = created && typeof created === 'object' ? created as { clip?: unknown; layer?: unknown } : undefined
      if (typeof reply?.clip !== 'number' || typeof reply.layer !== 'number') {
        throw new Error(`Filmcraft did not return an editable graphic clip and layer for ${graphic.kind}.`)
      }
      if (available.has('graphics.set')) {
        await control.execute('graphics.set', {
          clip: reply.clip,
          layer: reply.layer,
          props: graphicStyleProps(graphic, font, extraLines),
          time: ticks(graphic.seconds, plan.sequence.fps, warnings)
        })
      } else {
        const requested = Object.keys(graphicStyleProps(graphic, font, extraLines)).filter(key => key !== 'position' && key !== 'size')
        if (requested.length) warnings.push(`This Filmcraft version lacks graphics.set; ${graphic.kind} omitted requested style properties: ${requested.join(', ')}.`)
      }
    }
  } else if (plan.graphics.length) {
    warnings.push('This Filmcraft version lacks editable graphics.newText; hook and subtitle graphics were not added.')
  }
  await control.execute('file.saveAs', { path: projectPath })
}

export async function openInFilmcraft(projectId: string, clipId: string, executablePath?: string): Promise<{ projectPath: string; manifestPath: string; warnings: string[] }> {
  const project = await loadProject(projectId)
  const clip = project.clips.find(candidate => candidate.id === clipId)
  if (!clip) throw new Error('Clip not found.')
  const plan = buildFilmcraftPlan(project, clip)
  validatePlanMedia(plan)
  const executable = executablePath ? resolve(executablePath) : getSelectedFilmcraftExecutable() ?? (await findFilmcraftExecutables())[0]
  if (!executable || !isExecutable(executable)) throw new Error('Filmcraft executable was not found. Choose Filmcraft.exe and try again.')
  assertSupportedFilmcraftVersion(await readFilmcraftVersion(executable), executable)
  const paths = await unusedHandoffPaths(join(projectDir(projectId), 'filmcraft'), handoffName(clipId))
  const warnings = [...plan.warnings]
  let childStarted = false
  try {
    await writeFilmcraftManifest(paths.manifestPath, plan)
    const port = await reserveControlPort()
    const token = randomBytes(32).toString('hex')
    const child = spawn(executable, ['--control', String(port), '--empty', '--no-recover'], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
      env: { ...process.env, FILMCRAFT_CONTROL_TOKEN: token }
    })
    child.once('error', () => undefined)
    child.unref()
    childStarted = true
    const control = await connectWhenReady(port, token)
    try {
      await populateFilmcraft(control, plan, paths.projectPath, warnings)
    } finally {
      control.close()
    }
    return { projectPath: paths.projectPath, manifestPath: paths.manifestPath, warnings: [...new Set(warnings)] }
  } catch (error) {
    await Promise.all([rm(paths.projectPath, { force: true }), rm(paths.manifestPath, { force: true })])
    const message = error instanceof Error ? error.message : String(error)
    const inspection = childStarted ? ' Filmcraft remains open so you can inspect the partial handoff.' : ''
    throw new Error(`Filmcraft handoff failed: ${message}${inspection}`, { cause: error })
  }
}
