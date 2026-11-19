/**
 * Local development only: `npm run driver:code -w @ops/api -- 936` issues a shift code for a truck in the local
 * database, so the driver app can be tried before the dispatcher screen for codes exists. Refuses any database that
 * is not on this computer: real codes are issued by a dispatcher in OPS Disponent (CLAUDE.md rule 5).
 */
import '../env.js';
import { prisma } from '../lib/prisma.js';
import { issueDriverShift, normalizeVehicleInput } from '../services/driver-auth.js';

export function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname, protocol } = new URL(url);
    return /^postgres(ql)?:$/.test(protocol) && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production' || !isLocalDatabase(process.env.DATABASE_URL)) {
    console.error('Только для локальной базы на этом компьютере (DATABASE_URL на localhost). Рабочие коды выдаёт диспетчер.');
    process.exitCode = 2;
    return;
  }
  const wanted = normalizeVehicleInput(process.argv[2] ?? '');
  if (!wanted) {
    console.error('Укажите машину: npm run driver:code -w @ops/api -- 936');
    process.exitCode = 2;
    return;
  }
  const vehicles = await prisma.vehicle.findMany({ select: { id: true, vehicleNumber: true, licensePlate: true } });
  const vehicle = vehicles.find(item => normalizeVehicleInput(item.vehicleNumber) === wanted || (item.licensePlate !== null && normalizeVehicleInput(item.licensePlate) === wanted));
  if (!vehicle) {
    console.error(`Машина не найдена. Есть: ${vehicles.map(item => item.licensePlate ?? item.vehicleNumber).join(', ') || 'ни одной (запустите npm run db:setup)'}.`);
    process.exitCode = 2;
    return;
  }
  const { code, shift } = await issueDriverShift(prisma, vehicle.id, 72, { role: 'admin', sessionId: 'local-cli' });
  console.log(`Машина: ${vehicle.licensePlate ?? vehicle.vehicleNumber}\nКод смены: ${code}\nДействует до: ${shift.endsAt.toLocaleString('ru-RU', { timeZone: 'Europe/Berlin' })}`);
}

if (process.argv[1]?.endsWith('driver-code.ts')) {
  main().catch(() => {
    console.error('Не удалось выдать код. Проверьте, что база запущена и npm run db:setup выполнен.');
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}
