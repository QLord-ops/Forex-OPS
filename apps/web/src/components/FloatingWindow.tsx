import { Maximize2, Minus, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Bounds = { x: number; y: number; width: number; height: number }
const storageKey = 'ops-dispatcher-window-v1'
function constrain(bounds: Bounds): Bounds {
  const width = Math.min(Math.max(360, bounds.width), window.innerWidth - 24)
  const height = Math.min(Math.max(340, bounds.height), window.innerHeight - 24)
  return { width, height, x: Math.max(12, Math.min(bounds.x, window.innerWidth - width - 12)), y: Math.max(12, Math.min(bounds.y, window.innerHeight - height - 12)) }
}
function initialBounds(): Bounds {
  const fallback = { x: window.innerWidth - 652, y: 72, width: 620, height: window.innerHeight - 100 }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Bounds | null
    return constrain(saved && Object.values(saved).every(Number.isFinite) ? saved : fallback)
  } catch { return constrain(fallback) }
}

export function FloatingWindow({ title, children, onMinimize, open = true }: { title: string; children: ReactNode; onMinimize: () => void; open?: boolean }) {
  const [bounds, setBounds] = useState(initialBounds)
  const root = useRef<HTMLElement>(null)
  const operation = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; bounds: Bounds } | null>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    root.current?.focus()
    const resize = () => setBounds((current) => constrain(current))
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); previous?.focus() }
  }, [open])
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(bounds)) } catch { /* Storage can be disabled. */ } }, [bounds])
  function start(event: PointerEvent, kind: 'move' | 'resize') {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button') || window.innerWidth <= 640) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    operation.current = { kind, startX: event.clientX, startY: event.clientY, bounds }
  }
  function move(event: PointerEvent) {
    const active = operation.current
    if (!active) return
    const dx = event.clientX - active.startX; const dy = event.clientY - active.startY
    setBounds(constrain(active.kind === 'move' ? { ...active.bounds, x: active.bounds.x + dx, y: active.bounds.y + dy } : { ...active.bounds, width: active.bounds.width + dx, height: active.bounds.height + dy }))
  }
  return createPortal(<section hidden={!open} ref={root} tabIndex={-1} role="dialog" aria-label={title} className="dispatcher-window" style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height } as CSSProperties} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onMinimize() } }}>
    <header tabIndex={0} aria-label="Перемещение окна: используйте стрелки" className="dispatcher-window-header" onKeyDown={(event) => { if (event.target !== event.currentTarget || !['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); setBounds(constrain({ ...bounds, x: bounds.x + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0), y: bounds.y + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0) })) }} onPointerDown={(event) => start(event, 'move')} onPointerMove={move} onPointerUp={() => { operation.current = null }} onPointerCancel={() => { operation.current = null }}>
      <strong>{title}</strong><div><button type="button" aria-label="Вернуть окно в исходное положение" title="Сбросить положение" onClick={() => setBounds(constrain({ x: window.innerWidth - 652, y: 72, width: 620, height: window.innerHeight - 100 }))}><RotateCcw size={16} /></button><button type="button" aria-label="Развернуть окно" onClick={() => setBounds(constrain({ x: 12, y: 12, width: window.innerWidth - 24, height: window.innerHeight - 24 }))}><Maximize2 size={16} /></button><button type="button" aria-label="Свернуть помощника, сохранив черновик" onClick={onMinimize}><Minus size={18} /></button></div>
    </header>
    <div className="dispatcher-window-content">{children}</div>
    <div className="dispatcher-resize" role="separator" aria-label="Размер окна" tabIndex={0} onPointerDown={(event) => start(event, 'resize')} onPointerMove={move} onPointerUp={() => { operation.current = null }} onPointerCancel={() => { operation.current = null }} onKeyDown={(event) => { if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setBounds(constrain({ ...bounds, width: bounds.width + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0), height: bounds.height + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0) })) } }} />
  </section>, document.body)
}
