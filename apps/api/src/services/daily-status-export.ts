import ExcelJS from 'exceljs';
import { STATUS_GROUP_ORDER } from './daily-status.js';

type ExportRow = {
  vehicleNumber: string; statusGroup: string | null; weNortheim: string | null; servicePhone: string | null; aSchild: boolean; appSped: boolean;
  shown: { ort: string; start: string; ziel: string; ankunft: string; bemerkung: string; trailer: string };
};
const GROUP_TITLE: Record<string, string> = { NORD: 'NORD', SUED: 'SÜD', LUFE: 'LuFe' };
const HEADERS = ['LKW', 'Ort', 'Start', 'Ziel', 'Ankunft', 'Bemerkung', 'Trailer', 'WE in Northeim', 'Telefon Nummer', 'A Schild', 'AppSped'];
const WIDTHS = [8, 18, 9, 18, 10, 48, 12, 15, 18, 9, 9];
const RED = 'FFC00000';
const GREEN = 'FF008000';
const thin = { style: 'thin' as const, color: { argb: 'FF808080' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

/**
 * The list in the dispatcher's own layout ("Status neu", sheet Tabelle1): one block per group with its header row.
 * Every value is written as text, never as a formula, so nothing typed into Bemerkung can run in Excel.
 */
export async function buildStatusWorkbook(input: { date: string; generatedAt: Date | null; rows: ExportRow[] }): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OPS Disponent';
  const sheet = workbook.addWorksheet('Tabelle1', { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  sheet.columns = WIDTHS.map((width) => ({ width }));
  const stand = input.generatedAt
    ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(input.generatedAt).replace(',', '')
    : input.date;
  const standRow = sheet.addRow([`Stand: ${stand}`]);
  standRow.font = { italic: true, size: 10, color: { argb: 'FF555555' } };
  sheet.addRow([]);

  const groups = [...STATUS_GROUP_ORDER.map((key) => ({ key, title: GROUP_TITLE[key] })), { key: null, title: 'Ohne Gruppe' }];
  for (const group of groups) {
    const rows = input.rows.filter((row) => (row.statusGroup ?? null) === group.key || (group.key === null && !STATUS_GROUP_ORDER.includes(row.statusGroup as never)));
    if (!rows.length && group.key === null) continue;
    const header = sheet.addRow(HEADERS);
    header.font = { bold: true, size: 12 };
    header.alignment = { horizontal: 'center', vertical: 'middle' };
    header.eachCell((cell) => { cell.border = border; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }; });
    const title = sheet.addRow([group.title]);
    title.font = { bold: true, size: 12 };
    title.getCell(1).alignment = { horizontal: 'center' };
    for (let column = 1; column <= HEADERS.length; column += 1) title.getCell(column).border = border;
    for (const row of rows) {
      const line = sheet.addRow([row.vehicleNumber, row.shown.ort, row.shown.start, row.shown.ziel, row.shown.ankunft, row.shown.bemerkung,
        row.shown.trailer, row.weNortheim ?? '', row.servicePhone ?? '', row.aSchild ? 'ja' : 'nein', row.appSped ? 'ja' : 'nein'].map((value) => String(value)));
      line.alignment = { vertical: 'middle', horizontal: 'center' };
      line.getCell(6).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      line.getCell(1).font = { bold: true, color: { argb: RED } };
      line.getCell(1).numFmt = '@';
      line.getCell(9).numFmt = '@';
      line.getCell(10).font = { color: { argb: row.aSchild ? GREEN : RED } };
      line.getCell(11).font = { color: { argb: row.appSped ? GREEN : RED } };
      line.eachCell({ includeEmpty: true }, (cell) => { cell.border = border; });
    }
    sheet.addRow([]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
