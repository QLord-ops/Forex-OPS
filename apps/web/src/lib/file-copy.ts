/**
 * A file dragged out of Outlook is a temporary file Outlook rewrites or removes right after the drop. The browser reads it
 * only when the upload is sent, by then it is gone, and the upload fails without an answer («Failed to fetch», owner
 * 16.11.2026). The bytes are therefore copied into memory at once, while the file is still there.
 */
export const UNREADABLE_FILE_TEXT = 'Файл не удалось прочитать — так бывает с вложением, перетащенным прямо из Outlook. Сохраните вложение (правой кнопкой → «Сохранить как») и выберите его через «Выбрать файлы».'

export async function copyIntoMemory(files: File[]): Promise<{ files: File[]; unreadable: string[] }> {
  const copies = await Promise.all(files.map(async (file) => {
    try {
      const bytes = await file.arrayBuffer()
      return bytes.byteLength ? new File([bytes], file.name, { type: file.type, lastModified: file.lastModified }) : null
    } catch {
      return null
    }
  }))
  return { files: copies.filter((file): file is File => file !== null), unreadable: files.filter((_, index) => copies[index] === null).map((file) => file.name) }
}
