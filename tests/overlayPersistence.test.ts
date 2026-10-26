import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Clip, Project } from '@shared/types'
import { wholeVideoEdit } from '@shared/wholeVideo'
const mock = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mock.root } }))
import { loadProject, saveProject, updateProject } from '../src/main/projects'
beforeAll(async () => {
  mock.root = await mkdtemp(join(tmpdir(), 'cutawan-overlay-save-'))
})
afterAll(async () => {
  await rm(mock.root, { recursive: true, force: true })
})
it('loads a legacy clip and saves independent overlay edits without changing other clips', async () => {
  const clip = {
    id: 'one',
    edit: wholeVideoEdit({
      aspect: '9:16',
      autoZoom: false,
      durationSec: 5,
      focusTrack: null,
      contentType: 'speaker'
    })
  } as Clip
  const project: Project = {
    id: 'overlays',
    createdAt: 0,
    updatedAt: 0,
    name: 'Overlay test',
    video: {
      path: join(mock.root, 'missing.mp4'),
      fileName: 'missing.mp4',
      durationSec: 5,
      width: 640,
      height: 360,
      fps: 25,
      sizeBytes: 0,
      hasAudio: true
    },
    transcript: null,
    clips: [clip, { ...clip, id: 'two' }],
    prompt: '',
    videoType: 'auto'
  }
  await saveProject(project)
  expect(
    (await loadProject(project.id)).clips[0].edit.captionOverlay
  ).toBeUndefined()
  const overlays = {
    captionOverlay: { x: 0.2, y: 0.6, maxWidth: 0.7 },
    hookOverlay: { x: 0.5, y: 0.2, backgroundOpacity: 0.25, fontScale: 0.04 },
    hookDuration: 2.5
  }
  await updateProject(project.id, (fresh) => {
    Object.assign(fresh.clips[0].edit, overlays)
  })
  const loaded = await loadProject(project.id)
  expect(loaded.clips[0].edit).toMatchObject(overlays)
  expect(loaded.clips[1].edit.captionOverlay).toBeUndefined()
  await updateProject(project.id, (fresh) => {
    delete fresh.clips[0].edit.captionOverlay
  })
  expect(
    (await loadProject(project.id)).clips[0].edit.captionOverlay
  ).toBeUndefined()
})
