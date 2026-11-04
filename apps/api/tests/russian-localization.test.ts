import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Russian localization", () => {
  it("keeps Russian labels and duration units in the UI formatters", () => {
    const formatters = readFileSync(new URL("../../web/src/lib/format.ts", import.meta.url), "utf8");

    expect(formatters).toContain("Расчётная позиция — без данных GPS");
    expect(formatters).toContain("Без срока");
    expect(formatters).toContain("Активен");
    expect(formatters).toContain("Загрузка");
    expect(formatters).toContain("Зелёный");
    expect(formatters).toContain("Город неизвестен");
    expect(formatters).toContain("`${days} д`");
    expect(formatters).toContain("`${hours} ч`");
    expect(formatters).toContain("`${minutes} мин`");
  });

  it("declares Russian as the document and route-instruction language", () => {
    const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    const trafficRouting = readFileSync(new URL("../src/services/traffic-routing.ts", import.meta.url), "utf8");

    expect(html).toContain('<html lang="ru">');
    expect(trafficRouting).toContain('TOMTOM_ROUTING_LANGUAGE ?? "ru-RU"');
  });

  it("keeps the main navigation fully Russian", () => {
    const appShell = readFileSync(new URL("../../web/src/components/AppShell.tsx", import.meta.url), "utf8");

    // Auftrag stays German on purpose: it is the dispatchers' own word for the order.
    for (const label of ["Диспозиция", "Auftrag", "Машины", "Туры", "Аналитика", "Настройки"]) expect(appShell).toContain(`label: '${label}'`);
    expect(appShell).not.toMatch(/label: ['"](?:Dashboard|Fahrzeuge|Touren|Neuer Auftrag|Warnungen|Historie)['"]/);
  });
});
