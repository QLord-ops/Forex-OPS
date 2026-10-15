import ExcelJS, { type CellValue, type Row, type Worksheet } from "exceljs";

const { Workbook } = ExcelJS;

const MAX_SHEETS = 5;
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;
const MAX_CELL_CHARS = 2000;

export type OrderImportSource = "RULES" | "OPENAI";
export type DetectedImportLayout = "ROW_PER_STOP" | "LOAD_UNLOAD_COLUMNS" | "UNKNOWN";
export type ImportedStopType = "LOAD" | "UNLOAD";

export interface ImportWarning {
  code: string;
  message: string;
  sourceSheet?: string;
  sourceRow?: number;
  sourceColumn?: number;
}

export interface ImportedStopDraft {
  sequence: number;
  type: ImportedStopType;
  company: string | null;
  address: string | null;
  appointmentLocal: string | null;
  loadingMeters: number | null;
  referenceNumbers: string[];
  instructions: string | null;
  sourceRow: number;
  confidence: number;
}

export interface ImportedOrderDraft {
  orderNumber: string | null;
  vehicleNumber: string | null;
  stops: ImportedStopDraft[];
  warnings: ImportWarning[];
}

export interface BoundedExcelRow {
  sheetName: string;
  rowNumber: number;
  values: string[];
}

export interface ExcelOrderImportOptions {
  now?: Date;
  openAiApiKey?: string;
  openAiModel?: string;
  fetchImpl?: typeof fetch;
  openAiTimeoutMs?: number;
}

export interface ExcelImportPreview {
  source: OrderImportSource;
  detectedLayout: DetectedImportLayout;
  drafts: ImportedOrderDraft[];
  warnings: ImportWarning[];
  aiAvailable: boolean;
  usedAi: boolean;
  sheetsScanned: number;
  rowsScanned: number;
}

type FieldKey =
  | "orderNumber"
  | "vehicleNumber"
  | "stopType"
  | "company"
  | "address"
  | "appointmentAt"
  | "loadingMeters"
  | "referenceNumbers"
  | "instructions"
  | "loadCompany"
  | "loadAddress"
  | "loadAppointmentAt"
  | "unloadCompany"
  | "unloadAddress"
  | "unloadAppointmentAt";

interface NormalizedCell {
  value: string;
  warnings: ImportWarning[];
}

interface HeaderMatch {
  rowIndex: number;
  columns: Map<FieldKey, number>;
}

const aliases: Record<FieldKey, string[]> = {
  orderNumber: [
    "auftrag",
    "auftragsnummer",
    "auftragsnr",
    "auftragnr",
    "order",
    "order number",
    "order no",
    "order nr",
    "заказ",
    "номер заказа",
    "номер заявки",
    "заявка"
  ],
  vehicleNumber: [
    "fahrzeug",
    "fahrzeugnummer",
    "lkw",
    "truck",
    "truck number",
    "vehicle",
    "vehicle number",
    "машина",
    "авто",
    "тягач",
    "номер машины"
  ],
  stopType: ["typ", "stopp typ", "stop type", "type", "art", "операция", "тип", "загрузка выгрузка"],
  company: ["firma", "kunde", "company", "customer", "client", "компания", "клиент", "фирма"],
  address: ["adresse", "anschrift", "address", "место", "адрес", "адрес места"],
  appointmentAt: ["termin", "zeit", "datum", "appointment", "date", "time", "дата", "время", "дата время"],
  loadingMeters: ["ldm", "lademeter", "loading meters", "load meters", "погрузочные метры", "метры загрузки"],
  referenceNumbers: ["referenz", "referenznummer", "reference", "reference number", "ref", "референс", "номер референса"],
  instructions: ["bemerkung", "hinweis", "notiz", "instructions", "notes", "comment", "примечание", "инструкция", "комментарий"],
  loadCompany: [
    "ladefirma",
    "ladestelle firma",
    "loading company",
    "pickup company",
    "shipper",
    "фирма загрузки",
    "компания загрузки",
    "грузоотправитель"
  ],
  loadAddress: [
    "ladeadresse",
    "ladestelle",
    "beladeadresse",
    "loading address",
    "pickup address",
    "load address",
    "адрес загрузки",
    "место загрузки",
    "загрузка адрес"
  ],
  loadAppointmentAt: [
    "ladetermin",
    "ladezeit",
    "loading date",
    "pickup date",
    "load appointment",
    "дата загрузки",
    "время загрузки",
    "термин загрузки"
  ],
  unloadCompany: [
    "entladefirma",
    "entladestelle firma",
    "lieferfirma",
    "delivery company",
    "consignee",
    "фирма выгрузки",
    "компания выгрузки",
    "грузополучатель"
  ],
  unloadAddress: [
    "entladeadresse",
    "entladestelle",
    "lieferadresse",
    "unloading address",
    "delivery address",
    "unload address",
    "адрес выгрузки",
    "место выгрузки",
    "выгрузка адрес"
  ],
  unloadAppointmentAt: [
    "entladetermin",
    "entladezeit",
    "delivery date",
    "unload appointment",
    "дата выгрузки",
    "время выгрузки",
    "термин выгрузки"
  ]
};

export async function importExcelPreview(
  buffer: Buffer,
  filename = "import.xlsx",
  options: ExcelOrderImportOptions = {}
): Promise<ExcelImportPreview> {
  if (!filename.toLocaleLowerCase("de-DE").endsWith(".xlsx")) {
    return {
      source: "RULES",
      detectedLayout: "UNKNOWN",
      drafts: [],
      warnings: [{ code: "UNSUPPORTED_FILE", message: "Поддерживаются только файлы .xlsx." }],
      aiAvailable: Boolean(options.openAiApiKey ?? process.env.OPENAI_API_KEY),
      usedAi: false,
      sheetsScanned: 0,
      rowsScanned: 0
    };
  }

  const { rows, warnings, sheetsScanned } = await readBoundedExcelRows(buffer);
  const rulesResult = parseRowsWithRules(rows);
  const aiAvailable = Boolean(options.openAiApiKey ?? process.env.OPENAI_API_KEY);

  if (rulesResult.drafts.length > 0 || !aiAvailable) {
    return {
      source: "RULES",
      detectedLayout: rulesResult.detectedLayout,
      drafts: rulesResult.drafts,
      warnings:
        rulesResult.drafts.length > 0
          ? [...warnings, ...rulesResult.warnings]
          : [...warnings, ...rulesResult.warnings, warning("UNKNOWN_LAYOUT", "Поддерживаемая структура заказа не найдена.")],
      aiAvailable,
      usedAi: false,
      sheetsScanned,
      rowsScanned: rows.length
    };
  }

  try {
    const { importOrdersWithOpenAi } = await import("./openai-order-import.js");
    const aiResult = await importOrdersWithOpenAi(rows, {
      apiKey: options.openAiApiKey ?? process.env.OPENAI_API_KEY ?? "",
      model: options.openAiModel ?? process.env.OPENAI_IMPORT_MODEL ?? "gpt-5.4-mini",
      fetchImpl: options.fetchImpl,
      timeoutMs: options.openAiTimeoutMs
    });

    return {
      source: "OPENAI",
      detectedLayout: "UNKNOWN",
      drafts: aiResult.drafts,
      warnings: [...warnings, ...aiResult.warnings],
      aiAvailable,
      usedAi: true,
      sheetsScanned,
      rowsScanned: rows.length
    };
  } catch (error) {
    return {
      source: "RULES",
      detectedLayout: "UNKNOWN",
      drafts: [],
      warnings: [
        ...warnings,
        warning("OPENAI_FAILED", `Резервное распознавание OpenAI завершилось ошибкой: ${error instanceof Error ? error.message : "неизвестная ошибка"}`)
      ],
      aiAvailable,
      usedAi: false,
      sheetsScanned,
      rowsScanned: rows.length
    };
  }
}

export async function readBoundedExcelRows(buffer: Buffer): Promise<{
  rows: BoundedExcelRow[];
  warnings: ImportWarning[];
  sheetsScanned: number;
}> {
  const workbook = new Workbook();
  const excelBuffer = buffer as never;
  await workbook.xlsx.load(excelBuffer, {
    ignoreNodes: ["dataValidations", "extLst", "drawing", "picture", "conditionalFormatting", "tableParts"]
  });

  const warnings: ImportWarning[] = [];
  const sheets = workbook.worksheets.slice(0, MAX_SHEETS);
  const sheet = sheets.find(worksheetHasValues);

  if (!sheet) {
    return { rows: [], warnings: [warning("EMPTY_WORKBOOK", "В книге нет заполненных листов.")], sheetsScanned: sheets.length };
  }

  if (workbook.worksheets.length > MAX_SHEETS) {
    warnings.push(warning("SHEETS_TRUNCATED", `Проверены только первые ${MAX_SHEETS} листов.`));
  }

  for (const ignoredSheet of workbook.worksheets) {
    if (ignoredSheet !== sheet && worksheetHasValues(ignoredSheet)) {
      warnings.push(warning("SHEET_IGNORED", `Лист «${ignoredSheet.name}» содержит данные и был пропущен.`, ignoredSheet.name));
    }
  }

  const rows = extractRows(sheet, warnings);
  return { rows, warnings, sheetsScanned: sheets.length };
}

export function parseRowsWithRules(rows: BoundedExcelRow[]): {
  detectedLayout: DetectedImportLayout;
  drafts: ImportedOrderDraft[];
  warnings: ImportWarning[];
} {
  if (rows.length === 0) {
    return { detectedLayout: "UNKNOWN", drafts: [], warnings: [] };
  }

  const header = findBestHeader(rows);
  if (!header) {
    return { detectedLayout: "UNKNOWN", drafts: [], warnings: [] };
  }

  if (hasWideLayout(header.columns)) {
    return { detectedLayout: "LOAD_UNLOAD_COLUMNS", drafts: parseWideRows(rows, header), warnings: [] };
  }

  if (hasRowPerStopLayout(header.columns)) {
    return { detectedLayout: "ROW_PER_STOP", drafts: parseRowPerStopRows(rows, header), warnings: [] };
  }

  return { detectedLayout: "UNKNOWN", drafts: [], warnings: [] };
}

function extractRows(sheet: Worksheet, warnings: ImportWarning[]): BoundedExcelRow[] {
  const rowLimit = Math.min(sheet.rowCount || MAX_ROWS, MAX_ROWS);
  const columnLimit = Math.min(sheet.columnCount || MAX_COLUMNS, MAX_COLUMNS);
  const rows: BoundedExcelRow[] = [];

  if (sheet.rowCount > MAX_ROWS) {
    warnings.push(warning("ROWS_TRUNCATED", `Лист «${sheet.name}» сокращён до ${MAX_ROWS} строк.`, sheet.name));
  }

  if (sheet.columnCount > MAX_COLUMNS) {
    warnings.push(warning("COLUMNS_TRUNCATED", `Лист «${sheet.name}» сокращён до ${MAX_COLUMNS} столбцов.`, sheet.name));
  }

  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = readRow(row, columnLimit, sheet.name, warnings);
    if (values.some((value) => value.length > 0)) {
      rows.push({ sheetName: sheet.name, rowNumber, values });
    }
  }

  return rows;
}

function readRow(row: Row, columnLimit: number, sheetName: string, warnings: ImportWarning[]): string[] {
  const values: string[] = [];

  for (let columnNumber = 1; columnNumber <= columnLimit; columnNumber += 1) {
    const normalized = normalizeCellValue(row.getCell(columnNumber).value);
    if (normalized.warnings.length > 0) {
      warnings.push(
        ...normalized.warnings.map((item) => ({
          ...item,
          sourceSheet: sheetName,
          sourceRow: row.number,
          sourceColumn: columnNumber
        }))
      );
    }
    values.push(normalized.value);
  }

  return values;
}

function normalizeCellValue(value: CellValue): NormalizedCell {
  if (value === null || value === undefined) {
    return { value: "", warnings: [] };
  }

  if (value instanceof Date) {
    return { value: toExcelWallDateTime(value) ?? "", warnings: [] };
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return truncateCell(String(value));
  }

  if (typeof value === "string") {
    return truncateCell(value.trim());
  }

  if ("formula" in value || "sharedFormula" in value) {
    const result = "result" in value ? value.result : undefined;
    if (result === undefined || result === null) {
      return { value: "", warnings: [warning("FORMULA_NO_CACHE", "У ячейки с формулой нет сохранённого результата; формула не вычислялась.")] };
    }
    const normalized = normalizeCellValue(result);
    return {
      value: normalized.value,
      warnings: [warning("FORMULA_CACHED_RESULT", "Ячейка с формулой прочитана из сохранённого результата."), ...normalized.warnings]
    };
  }

  if ("richText" in value) {
    return truncateCell(value.richText.map((part) => part.text).join("").trim());
  }

  if ("text" in value) {
    return truncateCell(String(value.text).trim());
  }

  if ("error" in value) {
    return { value: "", warnings: [warning("CELL_ERROR", `Ошибка ячейки ${value.error} проигнорирована.`)] };
  }

  return truncateCell(String(value).trim());
}

function truncateCell(value: string): NormalizedCell {
  if (value.length <= MAX_CELL_CHARS) {
    return { value, warnings: [] };
  }

  return {
    value: value.slice(0, MAX_CELL_CHARS),
    warnings: [warning("CELL_TRUNCATED", `Значение ячейки сокращено до ${MAX_CELL_CHARS} символов.`)]
  };
}

function findBestHeader(rows: BoundedExcelRow[]): HeaderMatch | null {
  let best: HeaderMatch | null = null;
  let bestScore = 0;

  for (const row of rows.slice(0, Math.min(rows.length, 25))) {
    const columns = new Map<FieldKey, number>();

    row.values.forEach((value, index) => {
      const field = matchHeader(value);
      if (field && !columns.has(field)) {
        columns.set(field, index);
      }
    });

    const score = scoreHeader(columns);
    if (score > bestScore) {
      best = { rowIndex: rows.indexOf(row), columns };
      bestScore = score;
    }
  }

  return bestScore >= 3 ? best : null;
}

function scoreHeader(columns: Map<FieldKey, number>): number {
  let score = columns.size;
  if (hasWideLayout(columns)) {
    score += 4;
  }
  if (hasRowPerStopLayout(columns)) {
    score += 4;
  }
  return score;
}

function matchHeader(value: string): FieldKey | null {
  const normalized = normalizeHeader(value);
  if (!normalized) {
    return null;
  }

  const orderedFields: FieldKey[] = [
    "loadAppointmentAt",
    "unloadAppointmentAt",
    "loadAddress",
    "unloadAddress",
    "loadCompany",
    "unloadCompany",
    "orderNumber",
    "vehicleNumber",
    "loadingMeters",
    "referenceNumbers",
    "instructions",
    "appointmentAt",
    "stopType",
    "address",
    "company"
  ];

  for (const field of orderedFields) {
    if (aliases[field].some((alias) => normalizeHeader(alias) === normalized)) {
      return field;
    }
  }

  return null;
}

function normalizeHeader(value: string): string {
  return value
    .toLocaleLowerCase("de-DE")
    .replace(/[_./:;()[\]{}|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasWideLayout(columns: Map<FieldKey, number>): boolean {
  return columns.has("loadAddress") && columns.has("unloadAddress");
}

function hasRowPerStopLayout(columns: Map<FieldKey, number>): boolean {
  return columns.has("stopType") && columns.has("address");
}

function parseWideRows(rows: BoundedExcelRow[], header: HeaderMatch): ImportedOrderDraft[] {
  const drafts: ImportedOrderDraft[] = [];

  for (const row of rows.slice(header.rowIndex + 1)) {
    const loadAddress = getField(row, header.columns, "loadAddress");
    const unloadAddress = getField(row, header.columns, "unloadAddress");
    if (!loadAddress && !unloadAddress) {
      continue;
    }

    const warnings: ImportWarning[] = [];
    const stops: ImportedStopDraft[] = [];

    if (loadAddress) {
      const appointmentLocal = normalizeAppointment(getField(row, header.columns, "loadAppointmentAt"), warnings);
      stops.push({
        sequence: stops.length + 1,
        type: "LOAD",
        company: getField(row, header.columns, "loadCompany"),
        address: loadAddress,
        appointmentLocal,
        ...readCargoMetadata(row, header.columns),
        sourceRow: row.rowNumber,
        confidence: 0.92
      });
    } else {
      warnings.push(warning("MISSING_LOAD_ADDRESS", `Строка ${row.rowNumber}: отсутствует адрес загрузки.`, row.sheetName, row.rowNumber));
    }

    if (unloadAddress) {
      const appointmentLocal = normalizeAppointment(getField(row, header.columns, "unloadAppointmentAt"), warnings);
      stops.push({
        sequence: stops.length + 1,
        type: "UNLOAD",
        company: getField(row, header.columns, "unloadCompany"),
        address: unloadAddress,
        appointmentLocal,
        ...emptyCargoMetadata(),
        sourceRow: row.rowNumber,
        confidence: 0.92
      });
    } else {
      warnings.push(
        warning("MISSING_UNLOAD_ADDRESS", `Строка ${row.rowNumber}: отсутствует адрес выгрузки.`, row.sheetName, row.rowNumber)
      );
    }

    if (stops.length > 0) {
      drafts.push({
        orderNumber: getField(row, header.columns, "orderNumber"),
        vehicleNumber: getField(row, header.columns, "vehicleNumber"),
        stops,
        warnings
      });
    }
  }

  return drafts;
}

function parseRowPerStopRows(rows: BoundedExcelRow[], header: HeaderMatch): ImportedOrderDraft[] {
  const grouped = new Map<string, ImportedOrderDraft>();
  let anonymousIndex = 0;
  let currentGroupKey: string | null = null;
  let currentExplicitOrderNumber: string | null = null;
  let previousDataRowNumber: number | null = null;

  for (const row of rows.slice(header.rowIndex + 1)) {
    const address = getField(row, header.columns, "address");
    const rawType = getField(row, header.columns, "stopType");
    if (!address && !rawType) {
      continue;
    }

    const rowOrderNumber = getField(row, header.columns, "orderNumber");
    const hasRowGap = previousDataRowNumber !== null && row.rowNumber > previousDataRowNumber + 1;
    let orderNumber = rowOrderNumber;
    let groupKey: string;
    const rowWarnings: ImportWarning[] = [];

    if (rowOrderNumber) {
      currentExplicitOrderNumber = rowOrderNumber;
      currentGroupKey = `order-${rowOrderNumber}`;
      groupKey = currentGroupKey;
    } else if (currentExplicitOrderNumber && currentGroupKey) {
      orderNumber = currentExplicitOrderNumber;
      groupKey = currentGroupKey;
      rowWarnings.push(
        warning(
          "ORDER_NUMBER_CARRIED",
          `Строка ${row.rowNumber}: номер заказа отсутствует; используется предыдущий номер «${currentExplicitOrderNumber}».`,
          row.sheetName,
          row.rowNumber
        )
      );
    } else {
      if (!currentGroupKey || hasRowGap || currentGroupKey.startsWith("order-")) {
        currentGroupKey = `anonymous-${anonymousIndex}`;
        anonymousIndex += 1;
        if (hasRowGap) {
          rowWarnings.push(
            warning(
              "AMBIGUOUS_ANONYMOUS_ORDER",
              `Строка ${row.rowNumber}: перед точкой без номера заказа есть пустая строка; создан новый черновик.`,
              row.sheetName,
              row.rowNumber
            )
          );
        }
      }
      groupKey = currentGroupKey;
    }

    const draft =
      grouped.get(groupKey) ??
      {
        orderNumber,
        vehicleNumber: getField(row, header.columns, "vehicleNumber"),
        stops: [],
        warnings: []
      };

    draft.warnings.push(...rowWarnings);
    previousDataRowNumber = row.rowNumber;

    const type = normalizeStopType(rawType);
    if (!type) {
      draft.warnings.push(
        warning("UNSUPPORTED_STOP_TYPE", `Строка ${row.rowNumber}: неподдерживаемый тип точки «${rawType ?? ""}».`, row.sheetName, row.rowNumber)
      );
      grouped.set(groupKey, draft);
      continue;
    }

    const appointmentLocal = normalizeAppointment(getField(row, header.columns, "appointmentAt"), draft.warnings);
    if (!address) {
      draft.warnings.push(warning("MISSING_ADDRESS", `Строка ${row.rowNumber}: адрес отсутствует.`, row.sheetName, row.rowNumber));
      draft.stops.push({
        sequence: draft.stops.length + 1,
        type,
        company: getField(row, header.columns, "company"),
        address: null,
        appointmentLocal,
        ...readCargoMetadata(row, header.columns),
        sourceRow: row.rowNumber,
        confidence: 0.45
      });
      grouped.set(groupKey, draft);
      continue;
    }

    draft.stops.push({
      sequence: draft.stops.length + 1,
      type,
      company: getField(row, header.columns, "company"),
      address,
      appointmentLocal,
      ...readCargoMetadata(row, header.columns),
      sourceRow: row.rowNumber,
      confidence: 0.88
    });
    grouped.set(groupKey, draft);
  }

  return [...grouped.values()].filter((draft) => draft.stops.length > 0);
}

function getField(row: BoundedExcelRow, columns: Map<FieldKey, number>, field: FieldKey): string | null {
  const index = columns.get(field);
  if (index === undefined) {
    return null;
  }

  const value = row.values[index]?.trim();
  return value ? value : null;
}

function readCargoMetadata(row: BoundedExcelRow, columns: Map<FieldKey, number>) {
  const rawMeters = getField(row, columns, "loadingMeters");
  const normalizedMeters = rawMeters?.replace(",", ".").match(/\d+(?:\.\d+)?/)?.[0];
  const loadingMeters = normalizedMeters ? Number(normalizedMeters) : null;
  const referenceNumbers = (getField(row, columns, "referenceNumbers") ?? "")
    .split(/[;,|\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 20);
  return {
    loadingMeters: Number.isFinite(loadingMeters) ? loadingMeters : null,
    referenceNumbers,
    instructions: getField(row, columns, "instructions")
  };
}

function emptyCargoMetadata() {
  return { loadingMeters: null, referenceNumbers: [] as string[], instructions: null as string | null };
}

function normalizeStopType(value: string | null): ImportedStopType | null {
  const normalized = normalizeHeader(value ?? "");
  if (["load", "loading", "pickup", "beladung", "laden", "lade", "загрузка", "погрузка"].includes(normalized)) {
    return "LOAD";
  }
  if (
    ["unload", "unloading", "delivery", "entladung", "entladen", "entlade", "выгрузка", "разгрузка"].includes(
      normalized
    )
  ) {
    return "UNLOAD";
  }
  return null;
}

function normalizeAppointment(value: string | null, warnings: ImportWarning[]): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const isoish = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?)?$/);
  if (isoish) {
    if (!isoish[4] || !isoish[5]) {
      warnings.push(warning("MISSING_TIME", `В сроке «${trimmed}» указана дата, но отсутствует время.`));
      return null;
    }
    const candidate = `${isoish[1]}-${isoish[2]}-${isoish[3]}T${isoish[4]}:${isoish[5]}`;
    if (isValidLocalDateTime(candidate)) return candidate;
  }

  const german = trimmed.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})(?:\s+(\d{1,2})[:.](\d{2}))?$/);
  if (german) {
    if (!german[4] || !german[5]) {
      warnings.push(warning("MISSING_TIME", `В сроке «${trimmed}» указана дата, но отсутствует время.`));
      return null;
    }
    const year = german[3].length === 2 ? `20${german[3]}` : german[3];
    const candidate = `${year}-${german[2].padStart(2, "0")}-${german[1].padStart(2, "0")}T${german[4].padStart(2, "0")}:${german[5]}`;
    if (isValidLocalDateTime(candidate)) return candidate;
  }

  warnings.push(warning("UNSUPPORTED_APPOINTMENT", `Неподдерживаемый формат срока «${trimmed}».`));
  return null;
}

export function isValidLocalDateTime(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return false;
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute;
}

function warning(
  code: string,
  message: string,
  sourceSheet?: string,
  sourceRow?: number,
  sourceColumn?: number
): ImportWarning {
  return { code, message, sourceSheet, sourceRow, sourceColumn };
}

function toExcelWallDateTime(date: Date): string | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(
    2,
    "0"
  )}T${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function worksheetHasValues(sheet: Worksheet): boolean {
  const rowLimit = Math.min(sheet.rowCount || MAX_ROWS, MAX_ROWS);
  const columnLimit = Math.min(sheet.columnCount || MAX_COLUMNS, MAX_COLUMNS);

  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    for (let columnNumber = 1; columnNumber <= columnLimit; columnNumber += 1) {
      const normalized = normalizeCellValue(row.getCell(columnNumber).value);
      if (normalized.value.length > 0) {
        return true;
      }
    }
  }

  return false;
}
