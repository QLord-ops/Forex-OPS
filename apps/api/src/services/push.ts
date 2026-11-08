import type { PrismaClient } from '@prisma/client';
import webpush from 'web-push';
import { writeAuditLog, type AuditActor } from './audit-log.js';

/** VAPID keys from the server environment (never in the web build, git or logs). Missing keys: push is off. */
export type PushKeys = { publicKey: string; privateKey: string; subject: string };

export function readPushKeys(env: NodeJS.ProcessEnv = process.env): PushKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || 'mailto:dispo@forex-bovenden.de';
  return publicKey && privateKey ? { publicKey, privateKey, subject } : null;
}

export type WorkHours = { days: number[]; start: string; end: string };
export const DEFAULT_WORK_HOURS: WorkHours = { days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '18:00' };
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function validWorkHours(value: unknown): value is WorkHours {
  const hours = value as Partial<WorkHours> | null;
  return Boolean(hours) && Array.isArray(hours!.days) && hours!.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    && typeof hours!.start === 'string' && TIME.test(hours!.start) && typeof hours!.end === 'string' && TIME.test(hours!.end)
    && minutesOf(hours!.start) < minutesOf(hours!.end);
}

/** The same rule as the web (lib/work-hours.ts): Germany time, the phone's own working days and hours. */
export function isWorkTime(now: Date, hours: WorkHours = DEFAULT_WORK_HOURS) {
  const parts = Object.fromEntries(PARTS.formatToParts(now).map((part) => [part.type, part.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return hours.days.includes(WEEKDAYS.indexOf(parts.weekday)) && minutes >= minutesOf(hours.start) && minutes < minutesOf(hours.end);
}

/** What the sweep reads of an open notification (NotificationService.list gives it prioritized and stacked). */
export type PushCandidate = { id: string; vehicleId: string; type: string; message: string; createdAt: Date; priority: string; urgent: boolean; resolved: boolean };

/**
 * Who gets pushed what (plan of 06.11): during the phone's working hours every open decision, outside them only urgent
 * ones (left without BELADEN/ENTLADEN, critical stop). Information never rings a closed phone.
 */
export function shouldPush(item: PushCandidate, working: boolean) {
  if (item.resolved) return false;
  return working ? item.priority === 'ACTION' : item.urgent;
}

const HEADINGS: Record<string, string> = {
  STOP_DEPARTED: 'Машина уехала с точки', LONG_DWELL: 'Долгая стоянка', ROUTE_DEVIATION: 'Отклонение от маршрута',
  PREVIOUS_TOUR_OPEN: 'Прошлый тур не закрыт', APPOINTMENT_MATCH: 'Termin на проверку', AUTO_ARRIVAL: 'Прибытие по GPS', TRAFFIC_DELAY: 'Пробка на маршруте'
};

/** The push message: a heading by type, the notification text, one slot per truck on the phone (tag), a link to the truck. */
export function pushPayload(item: PushCandidate) {
  return {
    title: HEADINGS[item.type] ?? 'OPS FOREX',
    body: item.message.slice(0, 240),
    tag: `truck-${item.vehicleId}`,
    url: `/?vehicleId=${encodeURIComponent(item.vehicleId)}&card=${encodeURIComponent(item.vehicleId)}`
  };
}

type Sender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; urgency: 'high' | 'normal' }) => Promise<unknown>;
const WATERMARK = 'SYSTEM:PUSH_SWEEP';
const MAX_FAILURES = 10;

/** The push subscriptions of the dispatchers' phones and the sending of new decisions to them. Read-only towards Webfleet. */
export class PushService {
  constructor(private readonly db: PrismaClient, private readonly keys: PushKeys | null = readPushKeys(), private readonly send: Sender = webpush.sendNotification as unknown as Sender) {}

  config() { return { enabled: this.keys !== null, publicKey: this.keys?.publicKey ?? null }; }

  async subscribe(input: { endpoint: string; keys: { p256dh: string; auth: string }; workHours?: WorkHours | null }, actor?: AuditActor) {
    const data = { p256dh: input.keys.p256dh, auth: input.keys.auth, dispatcherId: actor?.dispatcherId ?? null, workHoursJson: input.workHours ? JSON.stringify(input.workHours) : null, failures: 0 };
    const saved = await this.db.pushSubscription.upsert({ where: { endpoint: input.endpoint }, create: { endpoint: input.endpoint, ...data }, update: data });
    // The endpoint is a capability URL: only its host goes into the audit log.
    await writeAuditLog(this.db, actor, { action: 'PUSH_SUBSCRIBED', entityType: 'PushSubscription', entityId: saved.id, metadata: { service: new URL(input.endpoint).host } });
    return { id: saved.id };
  }

  async unsubscribe(endpoint: string, actor?: AuditActor) {
    const removed = await this.db.pushSubscription.deleteMany({ where: { endpoint } });
    await writeAuditLog(this.db, actor, { action: 'PUSH_UNSUBSCRIBED', entityType: 'PushSubscription', entityId: 'device', metadata: { removed: removed.count } });
    return { removed: removed.count };
  }

  /**
   * Sends the notifications created since the last sweep. Every phone gets only what its dispatcher would see in the app
   * and what its working hours allow. A push service that says the subscription is gone (404/410) removes it.
   */
  async sweep(candidates: () => Promise<PushCandidate[]>, visibleTo: (dispatcherId: string | null) => Promise<(vehicleId: string) => boolean>, now = new Date()) {
    if (!this.keys) return { sent: 0, removed: 0 };
    const state = await this.db.integrationSyncState.findUnique({ where: { id: WATERMARK } });
    if (!state?.lastSnapshotAt) {
      // First run: start from now, an old backlog never rings.
      await this.db.integrationSyncState.upsert({ where: { id: WATERMARK }, create: { id: WATERMARK, provider: 'SYSTEM', lastSnapshotAt: now }, update: { lastSnapshotAt: now } });
      return { sent: 0, removed: 0 };
    }
    const since = state.lastSnapshotAt;
    const fresh = (await candidates()).filter((item) => item.createdAt > since);
    await this.db.integrationSyncState.update({ where: { id: WATERMARK }, data: { lastSnapshotAt: fresh.reduce((latest, item) => item.createdAt > latest ? item.createdAt : latest, since) } });
    if (!fresh.length) return { sent: 0, removed: 0 };
    const subscriptions = await this.db.pushSubscription.findMany();
    let sent = 0;
    let removed = 0;
    const visibility = new Map<string | null, (vehicleId: string) => boolean>();
    for (const subscription of subscriptions) {
      if (!visibility.has(subscription.dispatcherId)) visibility.set(subscription.dispatcherId, await visibleTo(subscription.dispatcherId));
      const visible = visibility.get(subscription.dispatcherId)!;
      let hours: unknown = null;
      try { hours = subscription.workHoursJson ? JSON.parse(subscription.workHoursJson) : null; } catch { hours = null; }
      const working = isWorkTime(now, validWorkHours(hours) ? hours : DEFAULT_WORK_HOURS);
      for (const item of fresh.filter((candidate) => visible(candidate.vehicleId) && shouldPush(candidate, working))) {
        try {
          await this.send({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(pushPayload(item)),
            { vapidDetails: this.keys, TTL: 6 * 3600, urgency: item.urgent ? 'high' : 'normal' });
          await this.db.pushSubscription.update({ where: { id: subscription.id }, data: { lastSentAt: now, failures: 0 } });
          sent += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410 || subscription.failures + 1 >= MAX_FAILURES) {
            await this.db.pushSubscription.deleteMany({ where: { id: subscription.id } });
            removed += 1;
            break;
          }
          await this.db.pushSubscription.update({ where: { id: subscription.id }, data: { failures: { increment: 1 } } });
        }
      }
    }
    return { sent, removed };
  }
}
