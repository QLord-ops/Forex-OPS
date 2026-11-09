import { expect, test, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const profile = (enabled: boolean) => ({
  version: 1,
  import: { routeSource: 'TOUR_REMARKS', warehouseWords: ['Lager', 'vorladen'], carrierNames: ['Schnellecke Transportlogistik'], dateOnlyMeansPlannedStart: true, zuladungWords: ['Zuladung'], aiNotes: '' },
  statusList: { enabled, dueLocalTime: '07:00', excludedVehicles: ['727', '2853'], weColumnLabel: enabled ? 'WE in Northeim' : null, showASchild: enabled, showAppSped: enabled },
  defaults: { serviceMinMinutes: 60, serviceMaxMinutes: 120, arrivalRadiusMeters: 500 }
})
const line = (id: string, code: string, name: string, vehicleCount: number, dispatchers: Array<{ id: string; name: string; primary: boolean }> = []) =>
  ({ id, customerId: 'c-sl', code, name, active: true, sortIndex: 0, departmentCompany: null, departmentAddress: null, departmentCity: null, vehicleCount, dispatchers })
const schnellecke = { id: 'c-sl', name: 'Schnellecke', slug: 'SCHNELLECKE', category: 'OEM_LOGISTICS', color: '#1d4ed8', active: true, aliases: ['Schnellecke'], profile: profile(true),
  lines: [line('l-nord', 'NORD', 'Nord', 2, [{ id: 'd-anna', name: 'Anna', primary: true }]), line('l-sued', 'SUED', 'Süd', 1)], createdAt: '', updatedAt: '' }
const walter = { ...schnellecke, id: 'c-wt', name: 'Walter (Tesla)', slug: 'WALTER_TESLA', color: '#b91c1c', aliases: ['Walter', 'Tesla'], profile: profile(false),
  lines: [{ ...line('l-tesla', 'TESLA', 'Tesla', 1), customerId: 'c-wt' }] }
const overview = { vehicles: 3, activeTours: 2, tours30d: 14, documents: 10, documentsWithoutCorrections: 7, mostCorrected: [{ field: 'company', count: 3 }, { field: 'STOP_REMOVED', count: 1 }], learnedRules: 2,
  recentDocuments: [{ id: 'doc-1', filename: 'Transportauftrag.pdf', mimeType: 'application/pdf', status: 'ATTACHED', tourId: 't1', createdAt: '2026-11-08T08:00:00Z' }] }

async function signedIn(page: Page, role: 'admin' | 'dispatcher', handler: (route: Route, path: string) => Promise<boolean>) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === '/auth/session') return json(route, { authenticated: true, role, csrfToken: 'e2e', dispatcherId: 'd-anna', displayName: 'Anna', onboardingCompletedAt: '2026-11-01T00:00:00Z' })
    if (path === '/notifications') return json(route, { notifications: [] })
    if (await handler(route, path)) return
    return json(route, [])
  })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort())
}

test('админ создаёт заказчиков из линий машин после предпросмотра и открывает профиль', async ({ page }) => {
  let migrated = false
  let profilePatch: unknown = null
  await signedIn(page, 'admin', async (route, path) => {
    if (path === '/customers') { await json(route, { customers: migrated ? [schnellecke, walter] : [] }); return true }
    if (path === '/customers/migration-preview') {
      await json(route, { customers: [
        { slug: 'SCHNELLECKE', name: 'Schnellecke', exists: false, statusList: true, lines: [{ code: 'NORD', name: 'Nord', vehicles: ['9724', '321'] }, { code: 'SUED', name: 'Süd', vehicles: ['124'] }] },
        { slug: 'WALTER_TESLA', name: 'Walter (Tesla)', exists: false, statusList: false, lines: [{ code: 'TESLA', name: 'Tesla', vehicles: ['2853'] }] }] }); return true
    }
    if (path === '/customers/migrate-from-lines') { migrated = true; await json(route, { result: [{ slug: 'SCHNELLECKE', created: true, lines: 2, vehicles: 3 }, { slug: 'WALTER_TESLA', created: true, lines: 1, vehicles: 1 }] }); return true }
    if (path === '/customers/c-sl' && route.request().method() === 'GET') { await json(route, { ...schnellecke, overview }); return true }
    if (path === '/customers/c-sl' && route.request().method() === 'PATCH') { profilePatch = route.request().postDataJSON(); await json(route, { id: 'c-sl' }); return true }
    return false
  })

  await page.goto('/customers')
  await expect(page.getByText('Заказчиков пока нет')).toBeVisible()
  await page.getByRole('button', { name: 'Показать, что будет создано' }).click()
  const migration = page.getByRole('region', { name: 'Перенос из линий машин' })
  await expect(migration).toContainText('Линия Nord: 9724, 321')
  await expect(migration).toContainText('Статус 07:00 продолжит формироваться как раньше.')
  await migration.getByRole('button', { name: 'Создать заказчиков и линии' }).click()
  await expect(migration).toContainText('SCHNELLECKE — линий 2, машин 3')
  await expect(page.getByRole('link', { name: /Schnellecke/ })).toContainText('Статус в 07:00')
  await expect(page.getByRole('list', { name: 'Линии Schnellecke' })).toContainText('Nord2 маш. · Anna')

  await page.getByRole('link', { name: /Schnellecke/ }).click()
  await expect(page.getByRole('heading', { name: 'Schnellecke' })).toBeVisible()
  await expect(page.getByText('Разобрано без правок')).toBeVisible()
  await expect(page.locator('.customer-stat', { hasText: 'Разобрано без правок' })).toContainText('70 %')
  await page.getByRole('tab', { name: 'Auftrag' }).click()
  await page.getByLabel('Заметки для ИИ').fill('Abteilung ist immer Ludwigsfelde')
  await page.getByRole('button', { name: 'Сохранить профиль' }).click()
  await expect.poll(() => profilePatch).toMatchObject({ profile: { import: { aiNotes: 'Abteilung ist immer Ludwigsfelde', warehouseWords: ['Lager', 'vorladen'] } } })
  await page.getByRole('tab', { name: 'Документы' }).click()
  await expect(page.getByRole('link', { name: 'Transportauftrag.pdf' })).toHaveAttribute('href', '/api/documents/doc-1/file')
})

test('Диспозиция: метка заказчика у машины и фильтр по заказчику', async ({ page }) => {
  const truck = (id: string, vehicleNumber: string) => ({ id, vehicleNumber, licensePlate: null, maxSpeedKmh: 85 })
  await signedIn(page, 'dispatcher', async (route, path) => {
    if (path === '/dashboard') {
      await json(route, { me: 'd-anna', vehicles: [
        { vehicle: truck('v1', '321'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: null, mine: true, customer: { id: 'c-sl', name: 'Schnellecke', slug: 'SCHNELLECKE', color: '#1d4ed8' }, line: { id: 'l-nord', code: 'NORD', name: 'Nord' } },
        { vehicle: truck('v2', '2853'), tour: null, statusText: 'IDLE', operationVersion: 1, assignedTo: null, mine: false, customer: { id: 'c-wt', name: 'Walter (Tesla)', slug: 'WALTER_TESLA', color: '#b91c1c' }, line: { id: 'l-tesla', code: 'TESLA', name: 'Tesla' } }
      ] }); return true
    }
    if (path.endsWith('/current-position')) { await json(route, { status: 'IDLE' }); return true }
    return false
  })
  await page.goto('/')
  await page.getByRole('group', { name: 'Чьи машины показать' }).getByRole('button', { name: /Весь парк/ }).click()
  const rows = page.locator('.fleet-list .vehicle-card')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: 'LKW 321' })).toContainText('Schnellecke · Nord')
  await page.getByRole('group', { name: 'Заказчик' }).getByRole('button', { name: /Walter/ }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('LKW 2853')
  await page.getByRole('group', { name: 'Заказчик' }).getByRole('button', { name: 'Все заказчики' }).click()
  await expect(rows).toHaveCount(2)
})

test('статус: вкладка на заказчика, колонки по его профилю', async ({ page }) => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const lists = [{ key: 'SCHNELLECKE', name: 'Schnellecke' }, { key: 'WALTER_TESLA', name: 'Walter (Tesla)' }]
  const report = (line: string) => ({ id: `r-${line}`, line, date: day, status: 'READY', preliminary: false, generatedAt: new Date().toISOString(), generatedByRole: 'system' })
  const row = (id: string, vehicleNumber: string, statusGroup: string) => ({ id, vehicleId: id, vehicleNumber, statusGroup, rule: 'EMPTY', startKind: 'NONE', ankunftKind: 'NONE', bemerkungAuto: 'Fahrzeug ist leer', bemerkung: null,
    weNortheim: null, servicePhone: null, aSchild: false, appSped: false, ortSource: null, trailerSource: null, version: 1, edited: false, flags: [], shown: { ort: 'Hannover', start: '', ziel: '', ankunft: '', bemerkung: 'Fahrzeug ist leer', trailer: '' } })
  await signedIn(page, 'dispatcher', async (route, path) => {
    if (path !== '/daily-status') return false
    const key = new URL(route.request().url()).searchParams.get('list') ?? 'SCHNELLECKE'
    await json(route, key === 'WALTER_TESLA'
      ? { date: day, editable: true, report: report(key), lists, list: { key, name: 'Walter (Tesla)', dueLocalTime: '08:30', groups: [{ code: 'TESLA', name: 'Tesla Grünheide' }], columns: { we: null, aSchild: false, appSped: false } }, rows: [row('w1', '2853', 'TESLA')] }
      : { date: day, editable: true, report: report(key), lists, list: { key, name: 'Schnellecke', dueLocalTime: '07:00', groups: [{ code: 'NORD', name: 'NORD' }], columns: { we: 'WE in Northeim', aSchild: true, appSped: true } }, rows: [row('s1', '9724', 'NORD')] })
    return true
  })
  await page.goto('/status')
  await expect(page.getByRole('heading', { name: 'Статус Schnellecke' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'WE in Northeim' })).toBeVisible()
  await page.getByRole('tab', { name: 'Walter (Tesla)' }).click()
  await expect(page.getByRole('heading', { name: 'Статус Walter (Tesla)' })).toBeVisible()
  await expect(page.getByText('Формируется автоматически в 08:30')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Tesla Grünheide/ })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'WE in Northeim' })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'A Schild' })).toHaveCount(0)
})

test('Auftrag читается по профилю заказчика моей линии и по кнопке заново — по профилю заказчика из шапки', async ({ page }) => {
  let uploadedFor: string | null = null
  let reparse: unknown = null
  const stops = [
    { sequence: 1, type: 'LOAD', company: 'Walter Logistics', address: 'Tesla-Straße 1, 15537 Grünheide', city: 'Grünheide', appointmentLocal: null, confidence: 0.9 },
    { sequence: 2, type: 'UNLOAD', company: 'BMW', address: 'BMW-Allee 1, 04349 Leipzig', city: 'Leipzig', appointmentLocal: null, confidence: 0.9 }
  ]
  const preview = (orderNumber: string, customer: unknown, warnings: unknown[] = []) => ({ source: 'OPENAI', detectedLayout: 'PDF', documentKind: 'ORDER', aiAvailable: true, documentId: 'doc-9', documentReused: false,
    attachedTourId: null, warnings, customer, drafts: [{ orderNumber, vehicleNumber: null, vehiclePlate: null, trailerPlate: null, tourRemarks: null, warnings: [], stops }] })
  const walterRef = { id: 'c-wt', key: 'WALTER_TESLA', name: 'Walter (Tesla)' }
  await signedIn(page, 'dispatcher', async (route, path) => {
    if (path === '/customers') { await json(route, { customers: [schnellecke, walter] }); return true }
    if (path === '/vehicles') { await json(route, [{ id: 'v1', vehicleNumber: '321', licensePlate: null, maxSpeedKmh: 85 }]); return true }
    if (path === '/imports/pdf/preview') {
      uploadedFor = new URL(route.request().url()).searchParams.get('customerId')
      await json(route, preview('W-1', { id: 'c-sl', key: 'SCHNELLECKE', name: 'Schnellecke', source: 'SELECTED', confidence: 1, profileApplied: true, detected: { ...walterRef, source: 'DOCUMENT', confidence: 0.6 } },
        [{ code: 'CUSTOMER_MISMATCH', message: 'Похоже, это Auftrag заказчика Walter (Tesla) (по шапке документа), а разобран по профилю Schnellecke.' }])); return true
    }
    if (path === '/documents/doc-9/reparse') {
      reparse = route.request().postDataJSON()
      await json(route, preview('W-1R', { ...walterRef, source: 'SELECTED', confidence: 1, profileApplied: true, detected: { ...walterRef, source: 'DOCUMENT', confidence: 0.6 } })); return true
    }
    if (path === '/geocode') { await json(route, { address: 'x', latitude: 52.4, longitude: 13.8, city: 'Grünheide', provider: 'e2e' }); return true }
    return false
  })

  await page.goto('/orders/new')
  const picker = page.getByRole('combobox', { name: 'Заказчик Auftrag' })
  await expect(picker).toHaveValue('c-sl')
  await page.locator('main input[type="file"][multiple]').first().setInputFiles({ name: 'walter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 walter') })
  await expect.poll(() => uploadedFor).toBe('c-sl')
  const note = page.getByRole('group', { name: 'Чей это Auftrag' })
  await expect(note).toContainText('Schnellecke')
  await expect(note).toContainText('выбран вами')
  await expect(page.getByText(/Похоже, это Auftrag заказчика Walter/)).toBeVisible()

  await note.getByRole('button', { name: 'Разобрать по профилю Walter (Tesla)' }).click()
  await expect.poll(() => reparse).toEqual({ customerId: 'c-wt' })
  await expect(page.getByLabel('Номер Auftrag')).toHaveValue('W-1R')
  await expect(note).toContainText('Walter (Tesla)')
  await expect(note.getByRole('button', { name: /Разобрать по профилю/ })).toHaveCount(0)
})

test('правило, выученное у двух заказчиков, админ делает общим', async ({ page }) => {
  let promoted = false
  const rule = { id: 'r1', kind: 'ALIAS', pattern: 'mb', value: 'Mercedes-Benz AG / Werk 065', active: true, hits: 2, applied: 0, builtIn: false, lastSeenAt: '2026-11-08T08:00:00Z', createdAt: '', updatedAt: '',
    scope: 'c-sl', customer: { id: 'c-sl', name: 'Schnellecke' }, promotable: true }
  page.on('dialog', (dialog) => void dialog.accept())
  await signedIn(page, 'admin', async (route, path) => {
    if (path === '/customers') { await json(route, { customers: [schnellecke, walter] }); return true }
    if (path === '/import-rules') {
      await json(route, { rules: promoted ? [{ ...rule, id: 'g1', scope: 'global', customer: null, promotable: false, hits: 4 }] : [rule], builtIn: [], corrections: { last7d: 3 } }); return true
    }
    if (path === '/import-rules/r1/promote') { promoted = true; await json(route, { ...rule, scope: 'global' }); return true }
    if (path === '/address-rules') { await json(route, { rules: [], builtIn: [] }); return true }
    return false
  })
  await page.goto('/settings')
  const rules = page.getByRole('region', { name: 'Правила импорта' })
  await expect(rules.getByRole('row', { name: /MB = Mercedes-Benz AG/ })).toContainText('Schnellecke')
  await rules.getByRole('button', { name: 'Сделать общим' }).click()
  await expect.poll(() => promoted).toBe(true)
  await expect(rules.getByRole('row', { name: /MB = Mercedes-Benz AG/ })).toContainText('Общее')
  await expect(rules.getByRole('button', { name: 'Сделать общим' })).toHaveCount(0)
})

test('админ находит точку, нарисованную не в том городе, и исправляет её из Настроек', async ({ page }) => {
  let fixed: string[] = []
  const issue = { stopId: 's3', tourId: 't1', tourStatus: 'ACTIVE', orderNumber: '71123726', vehicleId: 'v1', vehicleNumber: '7446', sequence: 3, type: 'UNLOAD',
    company: 'Schnellecke Transportlogistik GmbH', address: 'Lager', city: 'D 14974 Ludwigsfelde',
    current: { latitude: 53.55, longitude: 10, resolvedAddress: 'Lagerstraße, 20095 Hamburg, Deutschland' },
    proposed: { latitude: 52.3, longitude: 13.25, resolvedAddress: '14974 Ludwigsfelde, Deutschland', precision: 'POSTCODE_CITY', provider: 'nominatim' }, distanceKm: 251, attempts: [] }
  await signedIn(page, 'admin', async (route, path) => {
    if (path === '/customers') { await json(route, { customers: [] }); return true }
    if (path === '/import-rules') { await json(route, { rules: [], builtIn: [], corrections: { last7d: 0 } }); return true }
    if (path === '/address-rules') { await json(route, { rules: [], builtIn: [] }); return true }
    if (path === '/maintenance/stop-coordinates') { await json(route, fixed.length ? [] : [issue]); return true }
    if (path === '/maintenance/stop-coordinates/fix') { fixed = (route.request().postDataJSON() as { stopIds: string[] }).stopIds; await json(route, { fixed: [issue], skipped: [] }); return true }
    return false
  })
  await page.goto('/settings')
  const card = page.getByRole('region', { name: 'Координаты точек' })
  await card.getByRole('button', { name: 'Проверить точки' }).click()
  const row = card.getByRole('row', { name: /LKW 7446/ })
  await expect(row).toContainText('Lagerstraße, 20095 Hamburg')
  await expect(row).toContainText('14974 Ludwigsfelde, Deutschland')
  await expect(row).toContainText('251 км')
  await card.getByRole('button', { name: 'Исправить все · 1' }).click()
  await expect.poll(() => fixed).toEqual(['s3'])
  await expect(card.getByRole('status')).toContainText('Исправлено точек: 1')
  await expect(card.getByRole('row', { name: /LKW 7446/ })).toHaveCount(0)
})
