import ExcelJS from 'exceljs';
import { LEGACY_STATUS_LIST, type StatusListConfig } from './daily-status.js';

type ExportRow = {
  vehicleNumber: string; statusGroup: string | null; weNortheim: string | null; servicePhone: string | null; aSchild: boolean; appSped: boolean;
  shown: { ort: string; start: string; ziel: string; ankunft: string; bemerkung: string; trailer: string };
};
const RED = 'FFC00000';
const GREEN = 'FF008000';
const thin = { style: 'thin' as const, color: { argb: 'FF808080' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

type Column = { header: string; width: number; value: (row: ExportRow) => string; align?: 'left'; text?: boolean; color?: (row: ExportRow) => string; bold?: boolean };

/** The customer's columns: the fixed ones, then the free WE column, the phone and the A Schild / AppSped flags its profile shows. */
function columnsOf(config: StatusListConfig['columns']): Column[] {
  return [
    { header: 'LKW', width: 8, value: (row) => row.vehicleNumber, text: true, bold: true, color: () => RED },
    { header: 'Ort', width: 18, value: (row) => row.shown.ort },
    { header: 'Start', width: 9, value: (row) => row.shown.start },
    { header: 'Ziel', width: 18, value: (row) => row.shown.ziel },
    { header: 'Ankunft', width: 10, value: (row) => row.shown.ankunft },
    { header: 'Bemerkung', width: 48, value: (row) => row.shown.bemerkung, align: 'left' },
    { header: 'Trailer', width: 12, value: (row) => row.shown.trailer },
    ...(config.we ? [{ header: config.we, width: 15, value: (row: ExportRow) => row.weNortheim ?? '' }] : []),
    { header: 'Telefon Nummer', width: 18, value: (row) => row.servicePhone ?? '', text: true },
    ...(config.aSchild ? [{ header: 'A Schild', width: 9, value: (row: ExportRow) => row.aSchild ? 'ja' : 'nein', color: (row: ExportRow) => row.aSchild ? GREEN : RED }] : []),
    ...(config.appSped ? [{ header: 'AppSped', width: 9, value: (row: ExportRow) => row.appSped ? 'ja' : 'nein', color: (row: ExportRow) => row.appSped ? GREEN : RED }] : [])
  ];
}

/**
 * The list in the dispatcher's own layout ("Status neu", sheet Tabelle1): one block per line with its header row.
 * Every value is written as text, never as a formula, so nothing typed into Bemerkung can run in Excel.
 */
export async function buildStatusWorkbook(input: {
  date: string; generatedAt: Date | null; rows: ExportRow[];
  groups?: StatusListConfig['groups']; columns?: StatusListConfig['columns'];
  /** One dispatcher's Excel: only the blocks of lines that have their trucks. */
  skipEmptyGroups?: boolean;
}): Promise<Buffer> {
  const groupsConfig = input.groups ?? LEGACY_STATUS_LIST.groups;
  const columns = columnsOf(input.columns ?? LEGACY_STATUS_LIST.columns);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OPS Disponent';
  const sheet = workbook.addWorksheet('Tabelle1', { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  sheet.columns = columns.map((column) => ({ width: column.width }));
  const stand = input.generatedAt
    ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(input.generatedAt).replace(',', '')
    : input.date;
  const standRow = sheet.addRow([`Stand: ${stand}`]);
  standRow.font = { italic: true, size: 10, color: { argb: 'FF555555' } };
  sheet.addRow([]);

  const codes = groupsConfig.map((group) => group.code);
  const groups = [...groupsConfig.map((group) => ({ key: group.code as string | null, title: group.name })), { key: null, title: 'Ohne Gruppe' }];
  for (const group of groups) {
    const rows = input.rows.filter((row) => (row.statusGroup ?? null) === group.key || (group.key === null && !codes.includes(row.statusGroup ?? '')));
    if (!rows.length && (group.key === null || input.skipEmptyGroups)) continue;
    const header = sheet.addRow(columns.map((column) => column.header));
    header.font = { bold: true, size: 12 };
    header.alignment = { horizontal: 'center', vertical: 'middle' };
    header.eachCell((cell) => { cell.border = border; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }; });
    const title = sheet.addRow([group.title]);
    title.font = { bold: true, size: 12 };
    title.getCell(1).alignment = { horizontal: 'center' };
    for (let column = 1; column <= columns.length; column += 1) title.getCell(column).border = border;
    for (const row of rows) {
      const line = sheet.addRow(columns.map((column) => String(column.value(row))));
      line.alignment = { vertical: 'middle', horizontal: 'center' };
      columns.forEach((column, index) => {
        const cell = line.getCell(index + 1);
        if (column.align === 'left') cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        if (column.text) cell.numFmt = '@';
        if (column.color) cell.font = { bold: Boolean(column.bold), color: { argb: column.color(row) } };
      });
      line.eachCell({ includeEmpty: true }, (cell) => { cell.border = border; });
    }
    sheet.addRow([]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
