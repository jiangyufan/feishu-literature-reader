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

/** 文本质量诊断结果 */
export interface TextQuality {
  ok: boolean;          // 质量是否可用
  cjkRatio: number;     // 中文字符占比
  latinRatio: number;   // 英文字母占比
  cidCount: number;     // "cid:xxx" 乱码标记数量
  puaCount: number;     // 私有区乱码字符数量
  sample: string;       // 开头 300 字符样本（供用户检查）
  reason: string;       // 质量差时的原因说明
}

/** 快速评估解析文本是否可读（识别扫描件/字体编码异常导致的乱码） */
export function assessTextQuality(text: string): TextQuality {
  const s = (text || '').slice(0, 20000);
  const total = s.length || 1;
  let cjk = 0, latin = 0, pua = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    else if (c >= 0xe000 && c <= 0xf8ff) pua++;
  }
  const cidCount = (text.match(/cid:\d+/gi) || []).length;
  const cjkRatio = cjk / total;
  const latinRatio = latin / total;
  const readableRatio = cjkRatio + latinRatio;
  let ok = true;
  let reason = '';
  if (readableRatio < 0.35 || pua / total > 0.05 || cidCount > 50) {
    ok = false;
    reason = `解析文本可读率仅 ${(readableRatio * 100).toFixed(1)}%（中文+英文），私用区乱码 ${pua} 个、cid 乱码 ${cidCount} 个——这份 PDF 很可能是扫描件或使用了特殊字体编码，AI 拿到的是乱码，自然什么都提取不出来。请换文字版 PDF，或先用 OCR 工具转换。`;
  }
  return {
    ok,
    cjkRatio,
    latinRatio,
    cidCount,
    puaCount: pua,
    sample: text.slice(0, 300),
    reason,
  };
}
