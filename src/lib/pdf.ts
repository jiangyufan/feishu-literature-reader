// PDF 本地解析：pdfjs-dist 3.x（纯 JS，无 Python 依赖）
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore vite ?url 导入 worker 资源
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as unknown as string;

/** 解析 PDF 二进制为纯文本（含每页字符量统计） */
export async function parsePdf(
  data: ArrayBuffer,
  opts: { maxChars?: number; onProgress?: (page: number, total: number) => void } = {}
): Promise<{ text: string; pages: number; truncated: boolean }> {
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const total = doc.numPages;
  const parts: string[] = [];
  let chars = 0;
  const maxChars = opts.maxChars ?? 200000;
  let truncated = false;

  for (let p = 1; p <= total; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // 按 y 坐标分行拼装，保留基本阅读顺序
    let lastY: number | null = null;
    let line = '';
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        parts.push(line);
        line = '';
      }
      line += item.str;
      if (item.hasEOL) {
        parts.push(line);
        line = '';
      }
      lastY = y;
    }
    if (line) parts.push(line);
    parts.push('\n');
    chars = parts.reduce((s, x) => s + x.length, 0);
    opts.onProgress?.(p, total);
    if (chars >= maxChars) {
      truncated = true;
      break;
    }
  }
  await doc.destroy();
  return { text: parts.join('\n'), pages: total, truncated };
}
