import { Bot, FileUp, MessageSquare, Plus, Send, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { api } from '../lib/api'
import { assistantApi } from '../lib/assistant-api'
import { previewGeometry, setRoutePreview } from '../lib/route-preview'
import { resultTitle } from '../lib/termin-plan'
import type { AssistantConversation, AssistantMessage, AssistantProposal } from '../types/assistant'
import type { Vehicle } from '../types/domain'
import { AssistantResultCard, Preview } from './AssistantResultCard'
import { FloatingWindow } from './FloatingWindow'
import { QuickOrderPanel } from './QuickOrderPanel'
import './dispatcher-assistant.css'

const CONTEXT_EVENT = 'ops:assistant-context'
export function DispatcherAssistant() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'chat' | 'import'>('chat')
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [vehicleId, setVehicleId] = useState('')
  const [conversations, setConversations] = useState<AssistantConversation[]>([])
  const [conversationId, setConversationId] = useState('')
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [proposals, setProposals] = useState<AssistantProposal[]>([])
  const [text, setText] = useState(() => { try { return sessionStorage.getItem('ops-assistant-composer') || '' } catch { return '' } })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<unknown[]>([])
  const generation = useRef(0)
  const bottom = useRef<HTMLDivElement>(null)
  function showOnMap(value: unknown, label = 'Расчёт ИИ') {
    const geometry = previewGeometry(value)
    if (geometry.length < 2) return
    setRoutePreview({ geometry, label })
    navigate('/')
    setOpen(false)
  }
  useEffect(() => {
    void api.vehicles().then(setVehicles).catch(() => {})
    void assistantApi.conversations().then(setConversations).catch(() => {})
    const context = (event: Event) => { const detail = (event as CustomEvent<{ vehicleId?: string; open?: boolean; text?: string }>).detail; if (detail.vehicleId !== undefined) setVehicleId(detail.vehicleId); if (detail.open) setOpen(true); if (detail.text) { setText(detail.text); setView('chat') } }
    window.addEventListener(CONTEXT_EVENT, context)
    return () => window.removeEventListener(CONTEXT_EVENT, context)
  }, [])
  useEffect(() => { try { sessionStorage.setItem('ops-assistant-composer', text) } catch { /* Storage may be unavailable. */ } }, [text])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [messages, proposals, busy])
  async function selectConversation(id: string) {
    const version = ++generation.current
    setConversationId(id); setMessages([]); setProposals([]); setResults([]); setError('')
    if (!id) return
    setBusy(true)
    try { const result = await assistantApi.messages(id); if (generation.current === version) { setMessages(result.messages); setProposals(result.proposals) } }
    catch (cause) { if (generation.current === version) setError(cause instanceof Error ? cause.message : 'Ошибка загрузки диалога') }
    finally { if (generation.current === version) setBusy(false) }
  }
  async function sendMessage(content: string, draft?: { action: string; input: Record<string, unknown> }) {
    if (!content.trim() || busy) return
    setBusy(true); setError(''); setView('chat')
    const version = ++generation.current
    try {
      let id = conversationId
      if (!id) { const created = await assistantApi.create(); id = created.id; setConversationId(id); setConversations((current) => [created, ...current]) }
      const response = await assistantApi.send(id, { text: content, vehicleId: vehicleId || undefined, draft })
      const thread = await assistantApi.messages(id)
      if (generation.current !== version) return
      const fresh = response.results ?? (response.scenario ? [response.scenario] : [])
      setMessages(thread.messages); setProposals(thread.proposals); setResults(fresh); setText('')
      const mapResult = fresh.find((result) => previewGeometry(result).length > 1) ?? response.proposals.find((proposal) => previewGeometry(proposal.preview).length > 1)?.preview
      if (mapResult) showOnMap(mapResult)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось отправить сообщение'); throw cause }
    finally { setBusy(false) }
  }
  async function act(proposal: AssistantProposal, confirm: boolean) {
    setBusy(true); setError('')
    try {
      const result = await (confirm ? assistantApi.confirm(proposal.id) : assistantApi.cancel(proposal.id))
      setProposals((current) => current.map((item) => item.id === result.id ? result : item))
      if (confirm) window.dispatchEvent(new CustomEvent('ops:data-changed', { detail: { vehicleId: proposal.vehicleId } }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось применить предложение') }
    finally { setBusy(false) }
  }
  return <>
    {/* Opened from the dispatcher menu in the top bar (ops:assistant-context). */}
    {/* Keep the import form mounted when minimized: selected files and review edits survive. */}
    <div style={{ display: open ? 'contents' : 'none' }}>
      <FloatingWindow open={open} title="ИИ-диспетчер" onMinimize={() => setOpen(false)}>
        <div className="dispatcher-toolbar"><button type="button" className={view === 'chat' ? 'selected' : ''} onClick={() => setView('chat')}><MessageSquare size={16} />Диалог</button><button type="button" className={view === 'import' ? 'selected' : ''} onClick={() => setView('import')}><FileUp size={16} />Прикрепить Auftrag</button></div>
        <div className="dispatcher-context"><label>Машина<select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}><option value="">Определить из сообщения</option>{vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>LKW {vehicle.vehicleNumber}{vehicle.licensePlate ? ` · ${vehicle.licensePlate}` : ''}</option>)}</select></label><label>Диалог<select value={conversationId} disabled={busy} onChange={(event) => void selectConversation(event.target.value)}><option value="">Новый диалог</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title || 'Диалог'}</option>)}</select></label><button type="button" aria-label="Новый диалог" disabled={busy} onClick={() => void selectConversation('')}><Plus size={18} /></button></div>
        <div className="dispatcher-import-host" hidden={view !== 'import'}><QuickOrderPanel importOnly vehicles={vehicles} onImportActivity={() => { setOpen(true); setView('import') }} onCreated={async (id) => { setVehicles(await api.vehicles()); window.dispatchEvent(new CustomEvent('ops:data-changed', { detail: { vehicleId: id } })) }} /></div>
        <div className="dispatcher-chat" hidden={view !== 'chat'}>
          <div className="dispatcher-messages" aria-live="polite">
            {!messages.length ? <div className="dispatcher-welcome"><Bot size={28} /><h3>Что нужно сделать?</h3><p>Опишите ситуацию или прикрепите Auftrag. Перед изменением данных я покажу предложение для подтверждения.</p><button type="button" onClick={() => setText('Только расчёт: успеет ли машина сегодня после текущего тура посетить точки ')}>Рассчитать маршрут без добавления</button><button type="button" onClick={() => setText('Машина сломалась. ')}>Сообщить о поломке</button></div> : null}
            {messages.map((message) => {
              const savedScenario = message.role.toLowerCase() === 'scenario' ? parseScenario(message.content) : null
              if (savedScenario) return <article key={message.id} className="dispatcher-proposal"><strong>{resultTitle(savedScenario)}</strong><AssistantResultCard value={savedScenario} onShowMap={showOnMap} /></article>
              return <article key={message.id} className={`dispatcher-message ${message.role.toLowerCase() === 'user' ? 'from-user' : ''}`}><small>{message.role.toLowerCase() === 'user' ? 'Вы' : 'ИИ-диспетчер'}</small><p>{message.content}</p></article>
            })}
            {proposals.map((proposal) => <article className="dispatcher-proposal" key={proposal.id}><strong>{proposal.summary}</strong>{proposal.vehicleId ? <p>LKW {vehicles.find((vehicle) => vehicle.id === proposal.vehicleId)?.vehicleNumber || proposal.vehicleId}</p> : null}<Preview value={proposal.preview} /><small>{statusLabel(proposal.status)}</small>{['PENDING', 'PREPARED', 'READY'].includes(proposal.status.toUpperCase()) ? <div className="dispatcher-proposal-actions"><button type="button" disabled={busy} onClick={() => void act(proposal, false)}>Отменить</button><button type="button" className="primary-button" disabled={busy} onClick={() => void act(proposal, true)}>Подтвердить изменения</button></div> : null}</article>)}
            {/* The fresh results of this message: the thread above already holds their stored copies only after a reload. */}
            {results.filter((result) => !messages.some((message) => message.role.toLowerCase() === 'scenario' && sameResult(message.content, result))).map((result, index) =>
              <article key={`result-${index}`} className="dispatcher-proposal"><strong>{resultTitle(result)}</strong><AssistantResultCard value={result} onShowMap={showOnMap} /></article>)}
            {busy ? <p className="dispatcher-working"><LoaderCircle size={16} className="animate-spin" />Обрабатываю запрос…</p> : null}<div ref={bottom} />
          </div>
          <form className="dispatcher-compose" onSubmit={(event) => { event.preventDefault(); void sendMessage(text).catch(() => {}) }}><label className="sr-only" htmlFor="dispatcher-message">Сообщение помощнику</label><textarea id="dispatcher-message" value={text} onChange={(event) => setText(event.target.value)} placeholder="7490: дозагрузка в Берлине… или только просчитай маршрут" maxLength={12000} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void sendMessage(text).catch(() => {}) } }} /><div><span>Ctrl / ⌘ + Enter — отправить</span><button type="submit" disabled={busy || !text.trim()} aria-label="Отправить сообщение"><Send size={18} /></button></div></form>
        </div>
        {error ? <p className="dispatcher-error" role="alert">{error}</p> : null}
      </FloatingWindow>
    </div>
  </>
}

function parseScenario(content: string): unknown { try { return JSON.parse(content) } catch { return null } }
/** The thread stores the same JSON the reply carried; the stored copy wins so a result is not drawn twice. */
function sameResult(content: string, result: unknown): boolean {
  const stored = parseScenario(content) as { kind?: unknown; generatedAt?: unknown } | null
  const fresh = result as { kind?: unknown; generatedAt?: unknown } | null
  return Boolean(stored && fresh && stored.kind !== undefined && stored.kind === fresh.kind && stored.generatedAt === fresh.generatedAt)
}

function statusLabel(status: string) { return ({ PENDING: 'Ожидает подтверждения', PREPARED: 'Ожидает подтверждения', READY: 'Ожидает подтверждения', APPLIED: 'Выполнено', CONFIRMED: 'Подтверждено', CANCELLED: 'Отменено', FAILED: 'Ошибка выполнения', STALE: 'Исходные данные изменились — нужен новый расчёт' } as Record<string, string>)[status.toUpperCase()] || status }
