import { z } from 'zod';

export const CUSTOMER_CATEGORIES = ['OEM_LOGISTICS', 'WAREHOUSE', 'SPOT', 'OTHER'] as const;
export type CustomerCategory = (typeof CUSTOMER_CATEGORIES)[number];

const word = z.string().trim().min(2).max(60);

/** How this customer's Auftrag is written; read by the import (PR 3) and shown in the customer profile. */
const importSchema = z.object({
  /** Where the route is: the Tourbemerkung line, the stop table, or the text of an email. */
  routeSource: z.enum(['TOUR_REMARKS', 'TABLE', 'EMAIL_TEXT']).default('TOUR_REMARKS'),
  /** Words that mean the warehouse printed under Abteilung, never a town (Lager, vorladen, divers). */
  warehouseWords: z.array(word).max(20).default([]),
  /** The carrier or forwarder named on the document: never a stop or a place. */
  carrierNames: z.array(word).max(20).default([]),
  /** A date without a time is that day, planned at 06:00, not a Termin. */
  dateOnlyMeansPlannedStart: z.boolean().default(true),
  /** Words for a possible extra pick-up before unloading (Zuladung): a note on the tour, never a stop. */
  zuladungWords: z.array(word).max(10).default(['Zuladung']),
  /** Free notes for the AI, written by the dispatchers; passed to the model as data, never as instructions. */
  aiNotes: z.string().max(2000).default('')
}).default({});

/** The daily status list the customer receives (07:00 list of Schnellecke). */
const statusListSchema = z.object({
  enabled: z.boolean().default(false),
  dueLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ.').default('07:00'),
  /** Trucks of the customer's lines that the list leaves out. */
  excludedVehicles: z.array(z.string().trim().min(1).max(20)).max(200).default([]),
  /** Title of the free column the dispatcher fills in (WE in Northeim); null hides it. */
  weColumnLabel: z.string().trim().min(1).max(40).nullable().default(null),
  showASchild: z.boolean().default(false),
  showAppSped: z.boolean().default(false)
}).default({});

const defaultsSchema = z.object({
  serviceMinMinutes: z.number().int().min(5).max(600).default(60),
  serviceMaxMinutes: z.number().int().min(5).max(900).default(120),
  arrivalRadiusMeters: z.number().int().min(100).max(5000).default(500)
}).default({});

export const customerProfileSchema = z.object({
  version: z.literal(1).default(1),
  import: importSchema,
  statusList: statusListSchema,
  defaults: defaultsSchema
});

export type CustomerProfile = z.infer<typeof customerProfileSchema>;

/** A stored profile with every default filled in; a broken or older value never breaks a page or an import. */
export function parseProfile(json: string | null | undefined): CustomerProfile {
  try {
    const parsed = customerProfileSchema.safeParse(json ? JSON.parse(json) as unknown : {});
    if (parsed.success) return parsed.data;
  } catch { /* fall through to defaults */ }
  return customerProfileSchema.parse({});
}

/** A profile patch merged section by section, then validated as a whole. */
export function mergeProfile(current: CustomerProfile, patch: unknown): CustomerProfile {
  const input = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof CustomerProfile, unknown>>;
  const section = (key: 'import' | 'statusList' | 'defaults') => ({ ...current[key], ...(input[key] && typeof input[key] === 'object' ? input[key] as object : {}) });
  return customerProfileSchema.parse({ version: 1, import: section('import'), statusList: section('statusList'), defaults: section('defaults') });
}

/**
 * OEM inbound logistics with a Tourbemerkung route, as Schnellecke writes it (owner's rules 2026-11-04 … 06):
 * Lager / vorladen / divers = the Abteilung warehouse, the forwarder is never a place, 00:00 = planned 06:00,
 * Zuladung is a note. A new customer of this kind starts from here.
 */
export const OEM_TOUR_REMARKS_TEMPLATE: CustomerProfile = customerProfileSchema.parse({
  import: {
    routeSource: 'TOUR_REMARKS',
    warehouseWords: ['Lager', 'vorladen', 'divers', 'diverse'],
    carrierNames: [],
    dateOnlyMeansPlannedStart: true,
    zuladungWords: ['Zuladung']
  }
});

/** Schnellecke as the owner runs it today: the 07:00 list with WE in Northeim, A Schild and AppSped; 727 and 2853 stay out. */
export const SCHNELLECKE_PROFILE: CustomerProfile = customerProfileSchema.parse({
  ...OEM_TOUR_REMARKS_TEMPLATE,
  import: { ...OEM_TOUR_REMARKS_TEMPLATE.import, carrierNames: ['Schnellecke Transportlogistik', 'Schnellecke Logistics'] },
  statusList: { enabled: true, dueLocalTime: '07:00', excludedVehicles: ['727', '2853'], weColumnLabel: 'WE in Northeim', showASchild: true, showAppSped: true }
});
