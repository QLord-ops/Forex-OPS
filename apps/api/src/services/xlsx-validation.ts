import { inflateRawSync } from "node:zlib";

const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 300;

// XLSX is a ZIP container. Validate its real expanded size before ExcelJS loads it.
export function validateXlsxArchive(buffer: Buffer): void {
  if (buffer.length > 5 * 1024 * 1024) throw new Error("Файл Excel превышает 5 МБ.");
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      if (offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
        end = offset;
        break;
      }
    }
  }
  if (end < 0) throw new Error("Некорректный ZIP-контейнер Excel.");
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  let offset = buffer.readUInt32LE(end + 16);
  const centralEnd = offset + centralSize;
  if (count > MAX_ENTRIES || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)
    || buffer.readUInt16LE(end + 8) !== count || centralEnd !== end) {
    throw new Error("Архив Excel превышает допустимые ограничения.");
  }

  const names = new Set<string>();
  let expandedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > centralEnd || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Некорректная запись ZIP.");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const expandedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (next > centralEnd || flags & 1 || ![0, 8].includes(method) || expandedBytes + expandedSize > MAX_EXPANDED_BYTES) {
      throw new Error("Файл Excel зашифрован или слишком велик после распаковки (максимум 20 МБ).");
    }
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (names.has(name) || name.includes("..") || name.endsWith("vbaProject.bin")) throw new Error("Неподдерживаемое содержимое Excel.");
    names.add(name);
    if (localOffset + 30 > offset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Некорректная запись ZIP.");
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > offset) throw new Error("Некорректная длина ZIP.");
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const actualSize = method === 0 ? compressed.length : inflateRawSync(compressed, {
      maxOutputLength: Math.max(1, MAX_EXPANDED_BYTES - expandedBytes)
    }).length;
    if (actualSize !== expandedSize || expandedBytes + actualSize > MAX_EXPANDED_BYTES) throw new Error("Некорректная длина распакованного ZIP.");
    expandedBytes += actualSize;
    offset = next;
  }
  if (offset !== centralEnd || !names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) {
    throw new Error("Файл не содержит книгу Excel.");
  }
}
