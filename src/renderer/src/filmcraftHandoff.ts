import type { Clip, StylePreset } from '@shared/types'
import { applyStylePreset } from '@shared/stylePreset'

interface HandoffOptions<T> {
  projectId: string
  clipId: string
  executablePath?: string
  /** Saved global style preset, merged into the clip before it is saved and opened. */
  stylePreset?: StylePreset
  inFlight: { current: boolean }
  blurActive: () => void
  latestClip: (clipId: string) => Clip | undefined
  saveClip: (projectId: string, clip: Clip) => Promise<unknown>
  open: (projectId: string, clipId: string, executablePath?: string) => Promise<T>
}

/** Flush pending editor saves, persist the latest clip, then open Filmcraft. Returns null when a handoff is already running. */
export async function handoffToFilmcraft<T>(options: HandoffOptions<T>): Promise<T | null> {
  const { projectId, clipId, executablePath, inFlight } = options
  if (inFlight.current) return null
  inFlight.current = true
  try {
    options.blurActive()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const clip = options.latestClip(clipId)
    if (clip) {
      try {
        const edit = applyStylePreset(clip.edit, options.stylePreset)
        await options.saveClip(projectId, edit === clip.edit ? clip : { ...clip, edit })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Could not save your latest edits first: ${message}`, { cause: err })
      }
    }
    return await options.open(projectId, clipId, executablePath)
  } finally {
    inFlight.current = false
  }
}
