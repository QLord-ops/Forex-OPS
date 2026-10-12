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
  city?: string | null
  latitude: number
  longitude: number
  appointmentAt?: string | null
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
  predictedEta?: string | null
  currentEta?: string | null
  eta?: string | null
  predictedDelayMinutes?: number | null
  currentDelayMinutes?: number | null
  delayMinutes?: number | null
}

export interface DashboardVehicle {
  vehicle: Vehicle
  tour?: Tour | null
  statusText: string
  from?: Stop | null
  to?: Stop | null
  appointmentAt?: string | null
  eta?: string | null
  travelledKm?: number | null
  remainingKm?: number | null
  delayMinutes?: number | null
  risk: RiskColor
  warning?: string | null
}

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
  vehicles: DashboardVehicle[]
  riskyAppointments: RiskAppointment[]
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
  status: 'IDLE' | 'WAITING' | 'MOVING' | 'ARRIVED'
  coordinate?: Coordinate | null
  progress?: number | null
  distanceTravelledMeters?: number | null
  remainingDistanceMeters?: number | null
  eta?: string | null
  delayMinutes?: number | null
  startedAt?: string | null
  disclaimer?: string
  routeGeometry?: RouteGeometry | null
  travelledGeometry?: RouteGeometry | null
  remainingGeometry?: RouteGeometry | null
}

export interface GeocodeResult {
  address: string
  latitude: number
  longitude: number
  provider?: string
}

export type RouteGeometry =
  | Coordinate[]
  | {
      type: 'LineString'
      coordinates: Coordinate[]
    }
  | string

export interface CreateTourStopInput {
  sequence: number
  type: StopType
  company?: string
  address: string
  city?: string
  latitude: number
  longitude: number
  appointmentAt?: string | null
  serviceMinMinutes?: number
  serviceMaxMinutes?: number
}

export interface CreateTourInput {
  vehicleId: string
  orderNumber: string
  stops: CreateTourStopInput[]
}

export type OrderImportSource = 'RULES' | 'OPENAI'
export type OrderImportLayout = 'ROW_PER_STOP' | 'LOAD_UNLOAD_COLUMNS' | 'PDF' | 'UNKNOWN'

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
  appointmentLocal: string | null
  sourceRow?: number
  sourcePage?: number | null
  confidence: number
}

export interface ImportedOrderDraft {
  orderNumber: string | null
  vehicleNumber: string | null
  stops: ImportedStopDraft[]
  warnings: ImportWarning[]
}

export interface OrderImportPreview {
  source: OrderImportSource
  detectedLayout: OrderImportLayout
  drafts: ImportedOrderDraft[]
  warnings: ImportWarning[]
  aiAvailable: boolean
}

export type ExcelImportPreview = OrderImportPreview
