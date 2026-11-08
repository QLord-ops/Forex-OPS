/** Per-field confidence of a recognised Auftrag, as the server scored it (apps/api/src/services/field-confidence.ts). */
export type FieldLevel = 'OK' | 'CHECK' | 'DOUBT'
export type StopField = 'type' | 'company' | 'address' | 'city' | 'time' | 'loadingMeters' | 'references'
export type OrderField = 'orderNumber' | 'vehicle' | 'trailer'
export type FieldScore = { score: number; level: FieldLevel; reasons: string[]; evidence: string | null }
/** What the check shows: still to look at, or settled because the dispatcher changed or confirmed the value. */
export type FieldState = FieldLevel | 'RESOLVED'
export type FieldView = { key: string; field: StopField | OrderField; score: FieldScore; state: FieldState }

export const STOP_FIELDS: StopField[] = ['type', 'company', 'address', 'city', 'time', 'loadingMeters', 'references']

export const FIELD_LABEL: Record<StopField | OrderField, string> = {
  type: 'Тип точки', company: 'Фирма', address: 'Адрес', city: 'Город', time: 'Время', loadingMeters: 'LM', references: 'Референсы',
  orderNumber: 'Номер Auftrag', vehicle: 'LKW', trailer: 'Прицеп'
}

/** Reasons that explain a lower score; the others (address rule, Abteilung, alias) only explain a high one. */
const REASON_LABEL: Record<string, string> = {
  AI_UNSURE: 'ИИ не уверен',
  NO_EVIDENCE: 'не найдено в тексте документа',
  MISSING: 'не распознано',
  ADDRESS_NO_HOUSE_NUMBER: 'нет улицы с номером дома',
  ADDRESS_NO_POSTCODE: 'нет индекса',
  DATE_INVALID: 'дата не читается',
  DATE_PAST: 'дата уже прошла',
  PLACEHOLDER: 'только название из Tourbemerkung',
  FROM_OTHER_STOP_NOTE: 'взято из примечания к другой точке',
  WARNING: 'есть предупреждение',
  OFTEN_CORRECTED: 'у этого заказчика поле часто правят',
  CITY_ONLY_GEOCODE: 'на карте найден только город'
}

export const LEVEL_TEXT: Record<'CHECK' | 'DOUBT', string> = { CHECK: 'проверьте', DOUBT: 'под сомнением' }

export function reasonText(score: FieldScore): string {
  const reasons = score.reasons.map((reason) => REASON_LABEL[reason]).filter(Boolean)
  return reasons.length ? reasons.join(', ') : 'низкая уверенность распознавания'
}

const levelOf = (score: number): FieldLevel => (score >= 0.85 ? 'OK' : score >= 0.6 ? 'CHECK' : 'DOUBT')

/** The map found only the city for this address: whatever the document said, the street is not confirmed. */
export function withGeocode(score: FieldScore | undefined, precision: string | null | undefined): FieldScore | undefined {
  if (!score || !precision || ['EXACT', 'STREET', 'POSTCODE_CITY'].includes(precision) || score.score <= 0.5) return score
  return { ...score, score: 0.5, level: levelOf(0.5), reasons: [...score.reasons, 'CITY_ONLY_GEOCODE'] }
}

export const fieldKey = (draftStopIndex: number | string, field: string) => `${draftStopIndex}:${field}`
const same = (left: string | undefined, right: string | undefined) => (left ?? '').trim().toLocaleLowerCase('de-DE') === (right ?? '').trim().toLocaleLowerCase('de-DE')

export type ReviewStopInput = {
  draftStopIndex?: number | null
  fieldConfidence?: Partial<Record<StopField, FieldScore>>
  geocodePrecision?: string | null
  values: Record<StopField, string>
  original?: Partial<Record<StopField, string>>
}

/** Fields of each stop as the check shows them; stops the dispatcher added have no scores. */
export function stopViews(stops: ReviewStopInput[], verified: ReadonlySet<string>): FieldView[][] {
  return stops.map((stop) => {
    if (typeof stop.draftStopIndex !== 'number' || !stop.fieldConfidence) return []
    return STOP_FIELDS.flatMap((field) => {
      const score = field === 'address' ? withGeocode(stop.fieldConfidence?.address, stop.geocodePrecision) : stop.fieldConfidence?.[field]
      if (!score) return []
      const key = fieldKey(stop.draftStopIndex!, field)
      const changed = stop.original?.[field] !== undefined && !same(stop.values[field], stop.original[field])
      return [{ key, field, score, state: changed || verified.has(key) ? 'RESOLVED' as const : score.level }]
    })
  })
}

export function orderViews(scores: Partial<Record<OrderField, FieldScore>> | undefined, current: Partial<Record<OrderField, string>>, original: Partial<Record<OrderField, string>>, verified: ReadonlySet<string>): FieldView[] {
  return (['orderNumber', 'vehicle', 'trailer'] as OrderField[]).flatMap((field) => {
    const score = scores?.[field]
    if (!score) return []
    const key = fieldKey('order', field)
    const changed = current[field] !== undefined && !same(current[field], original[field])
    // The truck and trailer are picked by the dispatcher anyway: a doubtful reading is shown, it does not block.
    const level = field !== 'orderNumber' && score.level === 'DOUBT' ? 'CHECK' : score.level
    return [{ key, field, score, state: changed || verified.has(key) ? 'RESOLVED' as const : level }]
  })
}

/** Doubts still open block the confirmation; fields to check are only counted. */
export function openCounts(views: FieldView[]): { doubt: number; check: number } {
  return { doubt: views.filter((view) => view.state === 'DOUBT').length, check: views.filter((view) => view.state === 'CHECK').length }
}

export function stateClass(view: FieldView | undefined): string {
  return view?.state === 'DOUBT' ? 'field-state-doubt' : view?.state === 'CHECK' ? 'field-state-check' : ''
}
