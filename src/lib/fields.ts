// 提取字段定义（与提示词、表格字段一一对应）
export interface ExtractionField {
  name: string; // 多维表格字段名（自动创建）
  hint: string; // 提取要求
}

export const EXTRACTION_FIELDS: ExtractionField[] = [
  { name: '中文标题', hint: '文献的中文标题，外文文献请翻译成中文' },
  { name: '英文标题', hint: '文献原文标题（保留原文语言）' },
  { name: '作者', hint: '作者姓名，多人用顿号分隔' },
  { name: '发表年份', hint: '出版或发表年份，仅数字' },
  { name: '研究目的', hint: '该文献要解决的核心问题或研究目的，50 字以内' },
  { name: '研究现状', hint: '文中梳理的相关领域研究现状，80 字以内' },
  { name: '研究结论', hint: '核心结论或观点，100 字以内' },
  { name: '局限与建议', hint: '作者指出的局限或给出的建议，80 字以内' },
  { name: '一句话摘要', hint: '整篇文献的一句话概括，不超过 80 字' },
];
