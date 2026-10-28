export interface AssistantConversation { id: string; title: string; createdAt: string; updatedAt: string }
export interface AssistantMessage { id: string; role: string; content: string; createdAt: string }
export interface AssistantProposal { id: string; action: string; vehicleId?: string | null; status: string; summary: string; payload: Record<string, unknown>; preview: unknown; createdAt: string }
export interface AssistantReply { message: AssistantMessage; proposals: AssistantProposal[]; scenario?: unknown }
export interface AssistantThread { messages: AssistantMessage[]; proposals: AssistantProposal[] }
export interface RouteScenario {
  vehicleId: string; vehicleNumber: string; generatedAt: string
  completion: { earliest: string; latest: string }; startRange: { earliest: string; latest: string }
  finishToday: 'ON_TIME' | 'RISK' | 'LATE' | 'UNKNOWN'; preliminary: boolean; requiresDailyRest: boolean
  geometry: Array<[number, number]>; distanceMeters: number; warnings: string[]
  stops: Array<{ address: string; type: string; earliestArrival: string; latestArrival: string; earliestDeparture: string; latestDeparture: string; risk: string; serviceMinMinutes: number; serviceMaxMinutes: number }>
  downstreamQueueImpact: Array<{ tourId: string; stopId: string; delayMinutes: number; risk: string }>
}
