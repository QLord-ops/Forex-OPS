export interface AssistantConversation { id: string; title: string; createdAt: string; updatedAt: string }
export interface AssistantMessage { id: string; role: string; content: string; createdAt: string }
export interface AssistantProposal { id: string; action: string; vehicleId?: string | null; status: string; summary: string; payload: Record<string, unknown>; preview: unknown; createdAt: string }
export interface AssistantReply { message: AssistantMessage; proposals: AssistantProposal[]; scenario?: unknown; results?: unknown[] }

export type TerminSegmentType = 'DRIVE' | 'BREAK' | 'DAILY_REST' | 'SERVICE' | 'WAIT'
export interface TerminSegment { type: TerminSegmentType; startAt: string; endAt: string; startLocal: string; endLocal: string; durationSeconds: number; label: string; stopId: string | null }
export type TerminVerdict = 'OK' | 'RISK' | 'LATE'
export interface TerminCandidate { label: string; at: string; atLocal: string; verdict: TerminVerdict; deltaMinutes: number; note: string }
export interface TerminStopResult {
  stopId: string | null; label: string; type: 'LOAD' | 'UNLOAD' | 'VISIT'; driveSeconds: number | null
  earliestArrival: string | null; latestArrival: string | null; earliestArrivalLocal: string | null; latestArrivalLocal: string | null
  earliestDeparture: string | null; latestDeparture: string | null; waitingMinutes: number | null
  breaksBefore: number; restBefore: boolean; appointmentAt: string | null; verdict: TerminVerdict | 'NONE' | 'UNKNOWN'
}
/** What the server calculated for one Termin: the stored copy has no tachograph hours (DSGVO). */
export interface TerminPlan {
  kind: 'TERMIN'; generatedAt: string; vehicleId: string; vehicleNumber: string; licensePlate: string | null
  source: 'WEBFLEET' | 'CALCULATED'; preliminary: boolean
  start: { at: string; atLocal: string; label: string; address: string | null; positionSource: 'WEBFLEET' | 'CALCULATED' | 'MANUAL' | null; stale: boolean }
  target: { index: number; stopId: string | null; label: string; type: 'LOAD' | 'UNLOAD' | 'VISIT'; appointmentAt: string | null; terminRequired: boolean }
  stops: TerminStopResult[]; timeline: TerminSegment[]
  recommendation: { terminAt: string | null; terminAtLocal: string | null; basedOnArrival: string | null; bufferMinutes: number; afterDailyRest: boolean; restEndsAt: string | null; reason: string }
  candidates: TerminCandidate[]
  driver: { source: 'WEBFLEET' | 'CALCULATED'; preliminary?: boolean } | null
  warnings: string[]; notes: string[]; geometry: Array<[number, number]>; routingProviders: string[]
}
export interface BriefStop {
  stopId: string; tourId: string; sequence: number; type: string; label: string; company: string | null; city: string | null; address: string
  appointmentAt: string | null; appointmentAtLocal: string | null; windowStartAt: string | null; windowEndAt: string | null; plannedAt: string | null
  terminRequired: boolean; serviceMinMinutes: number; serviceMaxMinutes: number; arrivedAt: string | null; completedAt: string | null
  terminSharedWithStopId?: string | null
  eta: { earliest: string | null; earliestLocal: string | null; latest: string | null; latestLocal: string | null; risk: string; preliminary: boolean } | null
}
export interface VehicleBrief {
  kind: 'VEHICLE_BRIEF'; generatedAt: string; vehicleId: string; vehicleNumber: string; licensePlate: string | null; trailerPlate: string | null
  manualStoppedAt: string | null; calculatedClockPreliminary: boolean
  position: { status: string; state: string; address: string | null; source: 'WEBFLEET' | 'CALCULATED' | 'MANUAL' | null; ageMinutes: number | null; stale: boolean; remainingKm: number | null }
  activeTour: { tourId: string; orderNumber: string; currentStopId: string | null; stops: BriefStop[] } | null
  queuedTours: Array<{ tourId: string; orderNumber: string; plannedStartAt: string | null; plannedStartAtLocal: string | null; stops: BriefStop[] }>
  driver: { status: 'SIGNED_ON' | 'NONE' | 'WAITING' | 'NO_WEBFLEET'; workStateLabel: string | null; restingNow: { since: string | null; until: string | null } | null; summary: string }
  issues: Array<{ id: string; kind: string; description: string; expectedResolvedAt: string | null }>
}
export interface AssistantThread { messages: AssistantMessage[]; proposals: AssistantProposal[] }
export interface RouteScenarioStop {
  address: string; type: string; coords: { latitude: number; longitude: number }
  earliestArrival: string | null; latestArrival: string | null; earliestDeparture: string | null; latestDeparture: string | null
  risk: string; serviceMinMinutes: number; serviceMaxMinutes: number
}
export interface RouteOption {
  id: string; mainRoads: string[]; distanceMeters: number; durationSeconds: number; trafficDelaySeconds: number; hasRoadClosure: boolean
  geometry: Array<[number, number]>; trafficSegments: Array<{ from: number; to: number; level: 'SLOW' | 'JAM' | 'STANDSTILL' | 'CLOSED'; delaySeconds?: number; speedKmh?: number | null }>
  roadSegments?: Array<{ from: number; to: number; road: string }>
}
/** Up to three ways to drive one leg; option 0 is the router's best. */
export interface RouteLeg { from: string; to: string; options: RouteOption[] }
export interface RouteScenario {
  vehicleId: string | null; vehicleNumber: string | null; originAddress?: string; generatedAt: string
  completion: { earliest: string | null; latest: string | null }; startRange: { earliest: string; latest: string }
  finishToday: 'ON_TIME' | 'RISK' | 'LATE' | 'UNKNOWN'; preliminary: boolean; requiresDailyRest: boolean
  geometry: Array<[number, number]>; trafficSegments?: Array<{ from: number; to: number; level: 'SLOW' | 'JAM' | 'STANDSTILL' | 'CLOSED'; delaySeconds?: number; speedKmh?: number | null }>
  distanceMeters: number; warnings: string[]; routingProviders?: string[]
  stops: RouteScenarioStop[]
  legs?: RouteLeg[]
  downstreamQueueImpact: Array<{ tourId: string; stopId: string; delayMinutes: number | null; risk: string }>
}
