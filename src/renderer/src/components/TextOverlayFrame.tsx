import { useRef, useState } from 'react'
import type { Clip, TextOverlaySettings } from '@shared/types'
import { canvasPoint, moveOverlay } from '@shared/textOverlay'
import { useStore } from '../store'

/** Content-box coordinates, excluding the preview border even under CSS scaling. */
function canvasRect(element: HTMLElement): {
  left: number
  top: number
  width: number
  height: number
} {
  const rect = element.getBoundingClientRect()
  const sx = rect.width / Math.max(1, element.offsetWidth)
  const sy = rect.height / Math.max(1, element.offsetHeight)
  return {
    left: rect.left + element.clientLeft * sx,
    top: rect.top + element.clientTop * sy,
    width: element.clientWidth * sx,
    height: element.clientHeight * sy
  }
}
export default function TextOverlayFrame({
  clip,
  kind,
  settings,
  children
}: {
  clip: Clip
  kind: 'captionOverlay' | 'hookOverlay'
  settings: Required<TextOverlaySettings>
  children: React.ReactNode
}): React.JSX.Element {
  const [selected, select] = useState(false)
  const drag = useRef<{
    x: number
    y: number
    settings: Required<TextOverlaySettings>
    resize: boolean
    sx: number
    sy: number
  } | null>(null)
  return (
    <div
      role="group"
      aria-label={kind === 'hookOverlay' ? 'Hook title' : 'Subtitles'}
      tabIndex={0}
      onFocus={() => select(true)}
      onBlur={() => select(false)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        select(true)
        e.currentTarget.focus()
        e.currentTarget.setPointerCapture(e.pointerId)
        const point = canvasPoint(
          e.clientX,
          e.clientY,
          canvasRect(e.currentTarget.parentElement!)
        )
        drag.current = {
          ...point,
          settings,
          resize: (e.target as HTMLElement).dataset.resize === 'true',
          sx: Number((e.target as HTMLElement).dataset.sx ?? 1),
          sy: Number((e.target as HTMLElement).dataset.sy ?? 1)
        }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        e.preventDefault()
        e.stopPropagation()
        const point = canvasPoint(
          e.clientX,
          e.clientY,
          canvasRect(e.currentTarget.parentElement!)
        )
        const store = useStore.getState()
        const live = store.project?.clips.find((c) => c.id === clip.id)
        if (live)
          store.updateClipLocal({
            ...live,
            edit: {
              ...live.edit,
              [kind]: {
                ...live.edit[kind],
                ...moveOverlay(
                  drag.current.settings,
                  (point.x - drag.current.x) *
                    (drag.current.resize ? drag.current.sx : 1),
                  (point.y - drag.current.y) *
                    (drag.current.resize ? drag.current.sy : 1),
                  drag.current.resize
                )
              }
            }
          })
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        if (!drag.current) return
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        const store = useStore.getState()
        const live = store.project?.clips.find((c) => c.id === clip.id)
        if (live) void store.updateClip(live)
      }}
      onPointerCancel={() => {
        drag.current = null
        const store = useStore.getState()
        const live = store.project?.clips.find((c) => c.id === clip.id)
        if (live) void store.updateClip(live)
      }}
      style={{
        position: 'absolute',
        zIndex: 30,
        touchAction: 'none',
        userSelect: 'none',
        cursor: 'move',
        left: settings.x * 100 + '%',
        top: settings.y * 100 + '%',
        width: settings.maxWidth * 100 + '%',
        transform: 'translate(-50%, -50%)',
        textAlign: settings.align,
        outline: selected ? '1px solid #a78bfa' : undefined
      }}
    >
      {children}
      {selected &&
        ['0,0', '100,0', '0,100', '100,100'].map((corner) => {
          const [left, top] = corner.split(',')
          return (
            <span
              key={corner}
              aria-label={'Resize text ' + corner}
              data-resize="true"
              data-sx={left === '0' ? -1 : 1}
              data-sy={top === '0' ? -1 : 1}
              style={{
                position: 'absolute',
                left: left + '%',
                top: top + '%',
                width: 20,
                height: 20,
                display: 'grid',
                placeItems: 'center',
                transform: 'translate(-50%,-50%)',
                cursor: left === top ? 'nwse-resize' : 'nesw-resize'
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: '#a78bfa',
                  pointerEvents: 'none'
                }}
              />
            </span>
          )
        })}
    </div>
  )
}
