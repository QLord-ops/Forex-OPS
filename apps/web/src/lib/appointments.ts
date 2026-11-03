import { isoToBerlinLocal } from './berlin-time'
import type { AppointmentDocument, PendingAppointment } from '../types/domain'

/** A stored slip back into the shape the review card edits. */
export function pendingToDocument(item: PendingAppointment): AppointmentDocument {
  return {
    kind: item.documentKind, documentType: null, plate: item.vehiclePlate, trailerPlate: null, company: item.company, site: item.site, city: item.city,
    stopType: item.stopType, appointmentLocal: isoToBerlinLocal(item.appointmentAt) || null, windowStartLocal: isoToBerlinLocal(item.windowStartAt) || null,
    windowEndLocal: isoToBerlinLocal(item.windowEndAt) || null, references: item.references, sourceExcerpt: item.sourceExcerpt, fingerprint: item.fingerprint
  }
}
