import { MapPin, Truck } from 'lucide-react'
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react'

import { addressBookApi, suggestionSourceLabel, type AddressSuggestion } from '../lib/address-book'
import './address-input.css'

export type ExtraOption = { key: string; label: string; line2?: string; value: string }
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'list'> & {
  value: string
  onChange: (value: string) => void
  /** A saved address was chosen: it carries exact coordinates, no geocoding needed. */
  onPick: (item: AddressSuggestion) => void
  /** Options shown before the addresses, e.g. matching trucks for the first route point. */
  extraOptions?: ExtraOption[]
  /** Last row «Искать «…» на карте»: the old free search, for the map search field. */
  onFreeSearch?: (query: string) => void
}

/**
 * Address field with suggestions from the Webfleet address book and the sites OPS learned. After two letters a list opens;
 * ↑/↓ choose, Enter picks, Esc closes. Typing freely still works as before.
 */
export function AddressInput({ value, onChange, onPick, extraOptions = [], onFreeSearch, className, onKeyDown, onBlur, ...input }: Props) {
  const listId = useId()
  const [items, setItems] = useState<AddressSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [typed, setTyped] = useState(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    const query = value.trim()
    if (!typed || query.length < 2) { setItems([]); return }
    const timer = setTimeout(() => {
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      addressBookApi.search(query, controller.signal)
        // Any unexpected answer means "no suggestions": the field never breaks the form around it.
        .then((result) => { if (!controller.signal.aborted) { setItems(Array.isArray(result?.suggestions) ? result.suggestions : []); setActive(-1) } })
        .catch(() => { if (!controller.signal.aborted) setItems([]) })
    }, 200)
    return () => clearTimeout(timer)
  }, [value, typed])
  useEffect(() => () => request.current?.abort(), [])

  const rows: Array<{ kind: 'extra'; option: ExtraOption } | { kind: 'address'; item: AddressSuggestion } | { kind: 'free' }> = [
    ...extraOptions.map((option) => ({ kind: 'extra' as const, option })),
    ...items.map((item) => ({ kind: 'address' as const, item })),
    ...(onFreeSearch && value.trim().length >= 2 ? [{ kind: 'free' as const }] : [])
  ]
  const shown = open && typed && rows.length > 0

  function choose(index: number) {
    const row = rows[index]
    if (!row) return
    setOpen(false); setTyped(false); setActive(-1)
    if (row.kind === 'extra') onChange(row.option.value)
    else if (row.kind === 'address') { onPick(row.item); void addressBookApi.used(row.item.id).catch(() => undefined) }
    else onFreeSearch?.(value.trim())
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (shown && event.key === 'ArrowDown') { event.preventDefault(); setActive((current) => (current + 1) % rows.length); return }
    if (shown && event.key === 'ArrowUp') { event.preventDefault(); setActive((current) => (current <= 0 ? rows.length - 1 : current - 1)); return }
    if (shown && event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(active); return }
    if (shown && event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
    onKeyDown?.(event)
  }

  return <div className="address-input">
    <input {...input} className={className ?? 'field-input'} value={value} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={shown} aria-controls={listId}
      aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
      onChange={(event) => { setTyped(true); setOpen(true); onChange(event.target.value) }} onKeyDown={keyDown}
      onBlur={(event) => { setOpen(false); onBlur?.(event) }} onFocus={() => setOpen(true)} />
    {shown ? <ul id={listId} role="listbox" className="address-input-list">
      {rows.map((row, index) => <li key={row.kind === 'extra' ? `x-${row.option.key}` : row.kind === 'address' ? row.item.id : 'free'} id={`${listId}-${index}`} role="option" aria-selected={index === active}
        className={index === active ? 'address-input-option active' : 'address-input-option'}
        onMouseDown={(event) => { event.preventDefault(); choose(index) }} onMouseEnter={() => setActive(index)}>
        {row.kind === 'extra' ? <><Truck className="h-4 w-4" aria-hidden="true" /><span className="min-w-0"><strong>{row.option.label}</strong>{row.option.line2 ? <small>{row.option.line2}</small> : null}</span></>
          : row.kind === 'address' ? <><MapPin className="h-4 w-4" aria-hidden="true" /><span className="min-w-0"><strong>{row.item.label}</strong>{row.item.line2 ? <small>{row.item.line2}</small> : null}</span><em>{suggestionSourceLabel(row.item)}</em></>
            : <><MapPin className="h-4 w-4" aria-hidden="true" /><span className="min-w-0"><strong>Искать «{value.trim()}» на карте</strong></span></>}
      </li>)}
    </ul> : null}
  </div>
}
