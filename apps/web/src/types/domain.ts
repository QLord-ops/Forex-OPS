export type TourStatus = 'DRAFT' | 'QUEUED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
export type StopType = 'LOAD' | 'UNLOAD'
export type LegStatus = 'WAITING' | 'ACTIVE' | 'ARRIVED' | 'COMPLETED'
export type AlertType = 'TWO_HOURS' | 'ONE_HOUR'
export type RiskColor = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'GREY'

export type Coordinate = [number, number]

export interface Vehicle {
  id: string
  vehicleNumber: string
  licensePlate?: string | null
  currentTrailerPlate?: string | null
  manualPositionAddress?: string | null
  manualPositionLatitude?: number | null
  manualPositionLongitude?: number | null
  manualPositionAt?: string | null
  maxSpeedKmh: number
  createdAt?: string
  updatedAt?: string
}

export interface Stop {
  id: string
  tourId: string
  sequence: number
  type: StopType
  company?: string | null
  address: string
  sourceAddress?: string | null
  resolvedAddress?: string | null
  geocodePrecision?: 'EXACT' | 'STREET' | 'POSTCODE_CITY' | 'CITY' | null
  geocodeProvider?: string | null
  city?: string | null
  latitude: number
  longitude: number
  appointmentAt?: string | null
  appointmentWindowStartAt?: string | null
  appointmentWindowEndAt?: string | null
  plannedAt?: string | null
  departureDeadlineAt?: string | null
  terminRequired?: boolean
  loadingMeters?: number | null
  referenceNumbers?: string[] | null
  referenceNumbersJson?: string | null
  instructions?: string | null
  serviceMinMinutes?: number | null
  serviceMaxMinutes?: number | null
  arrivedAt?: string | null
  completedAt?: string | null
  createdAt?: string
  predictedEta?: string | null
  predictedDelayMinutes?: number | null
  status?: 'DONE' | 'CURRENT' | 'NEXT' | 'QUEUED'
}

export interface Leg {
  id: string
  tourId: string
  fromStopId: string
  toStopId: string
  distanceMeters: number
  routeGeometry: RouteGeometry
  routingDurationSeconds: number
  simulatedDurationSeconds: number
  startedAt?: string | null
  finishedAt?: string | null
  status: LegStatus
}

export interface Tour {
  id: string
  vehicleId: string
  orderNumber: string
  trailerPlate?: string | null
  tourRemarks?: string | null
  approachDurationSeconds?: number | null
  approachDistanceMeters?: number | null
  approachGeometry?: RouteGeometry | null
  planVersion?: number
  status: TourStatus
  previousTourId?: string | null
  plannedStartAt?: string | null
  actualStartAt?: string | null
  completedAt?: string | null
  createdAt?: string
  updatedAt?: string
  vehicle?: Vehicle
  stops?: Stop[]
  legs?: Leg[]
  events?: unknown[]
  predictedEta?: string | null
  currentEta?: string | null
  eta?: string | null
  predictedDelayMinutes?: number | null
  currentDelayMinutes?: number | null
  delayMinutes?: number | null
}

export interface DashboardVehicle {
  issues?: Array<{ id: string; kind: string; description: string; expectedResolvedAt: string | null; createdAt: string }>
  vehicle: Vehicle
  tour?: Tour | null
  statusText: string
  /** GPS: km and ETA measured from the Webfleet position; CALCULATED: from the drive timer. */
  etaSource?: 'GPS' | 'CALCULATED'
  offRouteMeters?: number | null
  /** The timer says the truck should be at the stop, but GPS has not confirmed it. */
  predictedArrival?: boolean
  operationVersion?: number
  /** Dispatcher who looks after the truck; null = free. */
  assignedTo?: { id: string; name: string } | null
  mine?: boolean
  from?: Stop | null
  to?: Stop | null
  appointmentAt?: string | null
  appointmentWindowStartAt?: string | null
  appointmentWindowEndAt?: string | null
  eta?: string | null
  travelledKm?: number | null
  remainingKm?: number | null
  delayMinutes?: number | null
  risk: RiskColor
  warning?: string | null
  currentStop?: Stop | null
  dwellMinutes?: number | null
  dwellSeverity?: 'NONE' | 'WARNING' | 'CRITICAL'
  /** The driver went into daily rest at this loading or unloading point (Webfleet tachograph); the work goes on after it. */
  restAtStop?: { stopId: string; stopType: 'LOAD' | 'UNLOAD'; place: string; since: string | null; until: string | null } | null
  /** What the driver does at the stop by the tachograph: daily rest only when the day is used up, otherwise a break, waiting or work. */
  stopActivity?: {
    kind: 'DAILY_REST' | 'BREAK' | 'WAITING' | 'WORKING'; stopId: string; stopType: 'LOAD' | 'UNLOAD'; place: string
    since: string | null; until: string | null; drivingLeftMs: number | null; shiftEndAt: string | null
  } | null
  currentAction?: {
    type: 'MARK_LOADED' | 'MARK_UNLOADED' | 'MANUAL_STOP' | 'RESUME'
    /** No GPS arrival yet: BELADEN/ENTLADEN records the arrival at the same moment. */
    withoutGpsArrival?: boolean
    /** GPS is fresh but never saw the truck at the stop: the dispatcher records the event by hand, marked as such. */
    manual?: boolean
    label: string
    stopId?: string | null
  } | null
  statusStartedAt?: string | null
  statusDurationSeconds?: number | null
  lastOperation?: {
    type: string
    createdAt: string
    stopId?: string | null
    reason?: string | null
  } | null
  clockSummary?: {
    preliminary: boolean
    remainingDrivingMinutes?: number | null
    breakInMinutes?: number | null
    remainingDutyMinutes?: number | null
    nextRestHours?: number | null
  } | null
  telemetry?: {
    source: 'WEBFLEET' | 'CALCULATED'
    checkedAt?: string | null
    stale: boolean
    ageSeconds?: number | null
    speedKmh?: number | null
    ignitionOn?: boolean | null
    standstill?: boolean | null
    courseDeg?: number | null
    fuelPercent?: number | null
    address?: string | null
    objectNo?: string | null
    objectName?: string | null
    usable?: boolean
  } | null
  mapPosition?: {
    coordinate: Coordinate
    source: 'WEBFLEET' | 'CALCULATED' | 'MANUAL'
    stale: boolean | null
    courseDeg: number | null
    standstill: boolean | null
  } | null
}

export interface DrivingTimes {
  referenceTime: string | null
  remainDrivingTodayMs: number | null
  totalDrivingTodayMs: number | null
  totalOtherWorkTodayMs: number | null
  totalAvailabilityTodayMs: number | null
  maxDrivingTodayMs: number | null
  remainDrivingWeekMs: number | null
  maxDrivingWeekMs: number | null
  shiftStartedAt: string | null
  latestShiftEndAt: string | null
  nextBreakAt: string | null
  nextBreakMinMs: number | null
  nextRestAt: string | null
  nextRestMinMs: number | null
  earliestNextShiftAt: string | null
  extendedShiftsUsed: number | null
  maxExtendedShifts: number | null
  reducedRestsUsed: number | null
  maxReducedRests: number | null
  restBalances: Array<{ until: string; ms: number }>
  infringements: boolean
  lastCardActivityAt: string | null
}

export type CardFeedStatus = 'OK' | 'WAITING' | 'UNAVAILABLE'

export interface CardEvent { id: string; at: string; level: 'INFO' | 'WARNING' | 'ALARM'; text: string; address: string | null; resolved: boolean }
export interface CardTrip { id: string; startAt: string; endAt: string | null; startAddress: string | null; endAddress: string | null; distanceKm: number | null; businessTrip: boolean }
export interface CardMaintenance { name: string; description: string | null; dueAt: string | null; dueOdometerKm: number | null }

export interface VehicleCardData {
  vehicleId: string
  vehicleNumber: string
  licensePlate: string | null
  currentTrailerPlate: string | null
  generatedAt: string
  webfleet: { objectNo: string | null; objectName: string | null; plate: string | null; vin: string | null; tankLiters: number | null; objectType: string | null } | null
  current: {
    recordedAt: string
    /** Last unit contact; newer than recordedAt while the truck stands. */
    lastContactAt?: string | null
    ageSeconds: number
    stale: boolean
    usable: boolean
    coordinate: Coordinate
    address: string | null
    speedKmh: number | null
    courseDeg: number | null
    standstill: boolean | null
    ignitionOn: boolean | null
    ignitionChangedAt: string | null
    fuelPercent: number | null
    fuelLiters: number | null
    odometerKm: number | null
    engineHours: number | null
    businessTrip: boolean
  } | null
  coupling: { status: CardFeedStatus; assetUid: string | null; assetNo: string | null; coupledAt: string | null } | null
  driver:
    | null
    | { status: 'WAITING' }
    | { status: 'NONE' }
    | {
        status: 'SIGNED_ON'
        name: string | null
        workState: number | null
        activitySince: string | null
        checkedAt: string
        drivingTimes: DrivingTimes | null
        drivingTimesStatus: 'OK' | 'NO_DATA' | 'UNAVAILABLE' | 'WAITING'
        optiDrive: number | null
      }
  events: { status: CardFeedStatus; unresolved: number; items: CardEvent[] } | null
  trips: { status: CardFeedStatus; items: CardTrip[] } | null
  maintenance: { status: CardFeedStatus; items: CardMaintenance[] } | null
}

export interface VehicleTrack { checkedAt: string; points: Coordinate[] }

export interface RiskAppointment {
  vehicle: Vehicle
  tour?: Tour | null
  stop: Stop
  eta: string
  delayMinutes: number
  alertType?: AlertType
}

export interface DashboardResponse {
  generatedAt?: string
  /** Personal account of the session; null for shared-password sessions. */
  me?: string | null
  vehicles: DashboardVehicle[]
  riskyAppointments?: RiskAppointment[]
}

export interface Alert {
  id: string
  vehicleId: string
  tourId: string
  stopId: string
  type: AlertType
  appointmentAt: string
  predictedEta: string
  predictedLateMinutes: number
  createdAt: string
  resolvedAt?: string | null
  vehicle?: Vehicle
  tour?: Tour
  stop?: Stop
}

export interface EventRecord {
  id: string
  vehicleId: string
  tourId: string
  stopId?: string | null
  type: 'LOADED' | 'UNLOADED'
  timestamp: string
  note?: string | null
  vehicle?: Vehicle
  tour?: Tour
  stop?: Stop
}

export interface OperationEventRecord {
  id: string
  vehicleId: string
  tourId: string
  stopId?: string | null
  type: string
  createdAt?: string | null
  reason?: string | null
  payloadJson?: string | null
  startedAt?: string | null
  arrivedAt?: string | null
  completedAt?: string | null
  timestamp?: string | null
  vehicle?: Vehicle
  tour?: Tour
  stop?: Stop
}

export interface TimeReport {
  vehicleId: string
  tourId: string
  stopId: string
  city?: string | null
  type: StopType
  arrivedAt: string
  completedAt?: string | null
  durationMinutes: number
}

export interface HistoryResponse {
  generatedAt: string
  truncated?: boolean
  limits?: { tours: number; events: number }
  tours: Tour[]
  events: EventRecord[]
  operationEvents?: OperationEventRecord[]
  timeReports?: TimeReport[]
}

export interface TimelineItem {
  id: string
  kind: 'STOP' | 'LEG'
  status: 'DONE' | 'CURRENT' | 'NEXT' | 'QUEUED'
  stop?: Stop
  leg?: Leg
  label: string
  meta?: string
}

export interface VehicleTimeline {
  vehicle: Vehicle
  tours: Tour[]
  items: TimelineItem[]
}

export interface CurrentPosition {
  vehicleId: string
  tourId?: string | null
  legId?: string | null
  geometryVersion?: string | null
  status: 'IDLE' | 'WAITING' | 'MOVING' | 'ARRIVED'
  coordinate?: Coordinate | null
  progress?: number | null
  distanceTravelledMeters?: number | null
  remainingDistanceMeters?: number | null
  eta?: string | null
  delayMinutes?: number | null
  startedAt?: string | null
  disclaimer?: string
  positionSource?: 'WEBFLEET' | 'CALCULATED' | 'MANUAL'
  trafficSegments?: TrafficSegment[]
  roadSegments?: RoadSegment[]
  trafficCheckedAt?: string | null
  telemetryRecordedAt?: string | null
  telemetryAgeSeconds?: number | null
  telemetryStale?: boolean
  routeGeometry?: RouteGeometry | null
  travelledGeometry?: RouteGeometry | null
  remainingGeometry?: RouteGeometry | null
  /** Indices of routeGeometry where a new piece starts; no line is drawn into them. */
  routeBreaks?: number[]
}

export interface GeocodeResult {
  address: string
  latitude: number
  longitude: number
  city?: string | null
  provider?: string
}

export interface AddressResolution extends GeocodeResult {
  sourceAddress: string
  resolvedAddress: string
  precision: 'EXACT' | 'STREET' | 'POSTCODE_CITY' | 'CITY'
  attempts: string[]
  researchUsed?: boolean
  researchCandidates?: Array<{
    address: string
    rationale: string
    sourceUrls: string[]
  }>
}

export interface AppointmentAnalysis {
  stopId: string
  tourId: string
  vehicleId: string
  version: number
  generatedAt: string
  appointmentAt: string
  windowStartAt?: string | null
  windowEndAt?: string | null
  previousAppointmentAt?: string | null
  earliestArrival: string | null
  latestArrival: string | null
  recommendedStartAt?: string | null
  bufferMinutes: number | null
  risk: 'ON_TIME' | 'RISK' | 'LATE' | 'UNKNOWN'
  action: 'LEAVE_BY' | 'LEAVE_NOW' | 'IN_TRANSIT' | 'ARRIVED' | 'UNKNOWN_POSITION'
  message: string
  preliminary: boolean
}

export type RouteGeometry =
  | Coordinate[]
  | {
      type: 'LineString'
      coordinates: Coordinate[]
    }
  | string

export interface CreateTourStopInput {
  /** Existing stop being edited; omitted fields keep their saved values. */
  id?: string
  /** Planned time without a Termin; never used for lateness. */
  plannedAt?: string | null
  departureDeadlineAt?: string | null
  /** Imported label whose place the dispatcher corrected; the server remembers the correction. */
  learnLabel?: string | null
  sequence: number
  type: StopType
  company?: string
  address: string
  sourceAddress?: string | null
  resolvedAddress?: string | null
  geocodePrecision?: AddressResolution['precision'] | null
  geocodeProvider?: string | null
  city?: string
  latitude: number
  longitude: number
  appointmentAt?: string | null
  appointmentWindowStartAt?: string | null
  appointmentWindowEndAt?: string | null
  loadingMeters?: number | null
  referenceNumbers?: string[] | null
  instructions?: string | null
  serviceMinMinutes?: number
  serviceMaxMinutes?: number
}

export interface CreateTourInput {
  vehicleId: string
  orderNumber: string
  trailerPlate?: string | null
  tourRemarks?: string | null
  stops: CreateTourStopInput[]
}

export type OrderImportSource = 'RULES' | 'OPENAI'
export type OrderImportLayout = 'ROW_PER_STOP' | 'LOAD_UNLOAD_COLUMNS' | 'PDF' | 'IMAGE' | 'UNKNOWN'

export interface ImportWarning {
  code: string
  message: string
  row?: number
  page?: number
  field?: string
}

export interface ImportedStopDraft {
  sequence: number
  type: StopType
  company: string | null
  address: string | null
  city?: string | null
  appointmentLocal: string | null
  /** Planned time when only a date was printed (06:00); never a Termin. */
  plannedLocal?: string | null
  /** The customer always sends a Termin and it has not arrived yet. */
  terminRequired?: boolean
  /** The imported company and city ("Seifert Bremen"): a corrected place is remembered for it. */
  sourceLabel?: string
  appointmentWindowStartLocal?: string | null
  appointmentWindowEndLocal?: string | null
  loadingMeters?: number | null
  referenceNumbers?: string[]
  instructions?: string | null
  sourceRow?: number
  sourcePage?: number | null
  sourceExcerpt?: string | null
  confidence: number
}

export interface ImportedOrderDraft {
  orderNumber: string | null
  vehicleNumber: string | null
  vehiclePlate?: string | null
  trailerPlate?: string | null
  tourRemarks?: string | null
  tourRemarksSourcePage?: number | null
  stops: ImportedStopDraft[]
  warnings: ImportWarning[]
}

export interface OrderImportPreview {
  source: OrderImportSource
  detectedLayout: OrderImportLayout
  /** PDF and screenshots: an Auftrag or a Termin slip. */
  documentKind?: 'ORDER' | 'APPOINTMENT'
  appointment?: AppointmentDocument | null
  match?: AppointmentMatch
  previous?: { id: string; status: string; attachedStopId: string | null } | null
  drafts: ImportedOrderDraft[]
  warnings: ImportWarning[]
  aiAvailable: boolean
}

/** A recognised Termin slip; times are Berlin wall-clock "YYYY-MM-DDTHH:mm". */
export interface AppointmentDocument {
  kind: 'VW_FAHRTENSCHEIN' | 'DECKBLATT' | 'OTHER'
  documentType: string | null
  plate: string | null
  trailerPlate: string | null
  company: string | null
  site: string | null
  city: string | null
  stopType: 'LOAD' | 'UNLOAD' | null
  appointmentLocal: string | null
  windowStartLocal: string | null
  windowEndLocal: string | null
  standgeldFromLocal?: string | null
  references: Array<{ label: string; value: string }>
  positions?: string[]
  sourceExcerpt: string | null
  confidence?: number
  warnings?: ImportWarning[]
  fingerprint?: string
}

export interface AppointmentCandidate {
  stopId: string; tourId: string; vehicleId: string; vehicleNumber: string; licensePlate: string | null
  orderNumber: string; tourStatus: string; planVersion: number; sequence: number; type: StopType
  company: string | null; address: string; city: string | null
  appointmentAt: string | null; windowStartAt: string | null; windowEndAt: string | null
  score: number; reasons: string[]
}

export interface AppointmentMatch {
  status: 'MATCHED' | 'AMBIGUOUS' | 'NONE'
  vehicle: { status: 'MATCHED'; vehicleId: string; vehicleNumber: string; plate: string } | { status: 'NOT_FOUND'; plate: string } | { status: 'NO_PLATE' }
  candidates: AppointmentCandidate[]
}

export interface PendingAppointment {
  id: string; fingerprint: string; documentKind: AppointmentDocument['kind']; vehiclePlate: string | null
  company: string | null; site: string | null; city: string | null; stopType: StopType | null
  appointmentAt: string | null; windowStartAt: string | null; windowEndAt: string | null
  references: Array<{ label: string; value: string }>; sourceExcerpt: string | null; createdAt: string
  match: AppointmentMatch
}

export type ExcelImportPreview = OrderImportPreview

export type TrafficLevel = 'SLOW' | 'JAM' | 'STANDSTILL' | 'CLOSED'
/** Congested stretch of a route line, as point indices (inclusive). */
/** Stretch of the route on one Autobahn (A7) or Bundesstraße (B3), point indices of the drawn line. */
export interface RoadSegment { from: number; to: number; road: string }
export interface TrafficSegment { from: number; to: number; level: TrafficLevel; delaySeconds?: number; speedKmh?: number | null }
