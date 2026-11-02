export interface AssistantConversation { id: string; title: string; createdAt: string; updatedAt: string }
export interface AssistantMessage { id: string; role: string; content: string; createdAt: string }
export interface AssistantProposal { id: string; action: string; vehicleId?: string | null; status: string; summary: string; payload: Record<string, unknown>; preview: unknown; createdAt: string }
export interface AssistantReply { message: AssistantMessage; proposals: AssistantProposal[]; scenario?: unknown }
export interface AssistantThread { messages: AssistantMessage[]; proposals: AssistantProposal[] }
export interface RouteScenarioStop {
  address: string; type: string; coords: { latitude: number; longitude: number }
  earliestArrival: string | null; latestArrival: string | null; earliestDeparture: string | null; latestDeparture: string | null
  risk: string; serviceMinMinutes: number; serviceMaxMinutes: number
}
export interface RouteOption {
  id: string; mainRoads: string[]; distanceMeters: number; durationSeconds: number; trafficDelaySeconds: number; hasRoadClosure: boolean
  geometry: Array<[number, number]>; trafficSegments: Array<{ from: number; to: number; level: 'SLOW' | 'JAM' | 'STANDSTILL' | 'CLOSED'; delaySeconds?: number; speedKmh?: number | null }>
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
