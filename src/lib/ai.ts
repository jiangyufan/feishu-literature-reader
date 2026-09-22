// AI 生成层：支持多平台 OpenAI 兼容接口
export interface TargetField {
  name: string;       // 字段名
  fieldId: string;    // 字段 ID（用于写回）
  description: string; // 字段描述（可选，来自表里的"提示词"或字段名本身）
}

export interface ProviderConfig {
  label: string;
  baseUrl: string;
  apiKeyPlaceholder: string;
  /** 是否支持浏览器直接 fetch（CORS 放行） */
  browserDirect: boolean;
  /** 请求头特殊处理 */
  extraHeaders?: Record<string, string>;
  models: string[];
}

export type ProviderId = 'siliconflow' | 'kimi';

export interface AiConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
}

// 硅基流动全部可用对话模型（按用户提供的清单整理的对话类/通用类）
const SILICONFLOW_MODELS = [
  // Kimi 系
  'Pro/moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.7-Code',
  // 腾讯混元
  'tencent/Hy4-preview',
  // 智谱 GLM
  'zai-org/GLM-5.3',
  'zai-org/GLM-5.2',
  'zai-org/GLM-5.1',
  'Pro/zai-org/GLM-5.1',
  // DeepSeek
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-ai/DeepSeek-V4-Pro',
  'deepseek-ai/DeepSeek-V3.2',
  'Pro/deepseek-ai/DeepSeek-V3.2',
  'deepseek-ai/DeepSeek-V3.1-Terminus',
  'Pro/deepseek-ai/DeepSeek-V3.1-Terminus',
  'deepseek-ai/DeepSeek-R1',
  'Pro/deepseek-ai/DeepSeek-R1',
  'deepseek-ai/DeepSeek-V3',
  'Pro/deepseek-ai/DeepSeek-V3',
  // 美团
  'meituan-longcat/LongCat-2.0',
  // 通义千问
  'Qwen/Qwen3.8-27B',
  'Qwen/Qwen3.6-35B-A3B',
  'Qwen/Qwen3.6-27B',
  'Qwen/Qwen3.5-122B-A10B',
  'Qwen/Qwen3.5-35B-A3B',
  'Qwen/Qwen3.5-27B',
  'Qwen/Qwen3.5-9B',
  'Qwen/Qwen3.5-4B',
  'Qwen/Qwen3-32B',
  'Qwen/Qwen3-14B',
  'Qwen/Qwen3-8B',
  'Qwen/Qwen2.5-72B-Instruct-128K',
  'Qwen/Qwen2.5-72B-Instruct',
  'Qwen/Qwen2.5-32B-Instruct',
  'Qwen/Qwen2.5-14B-Instruct',
  'Qwen/Qwen2.5-7B-Instruct',
  'Pro/Qwen/Qwen2.5-7B-Instruct',
  // 阶跃星辰
  'stepfun-ai/Step-3.5-Flash',
  // 智谱 GLM-4
  'THUDM/GLM-4-32B-0414',
  'THUDM/GLM-Z1-9B-0414',
  'THUDM/GLM-4-9B-0414',
  // 字节
  'ByteDance-Seed/Seed-OSS-36B-Instruct',
  // 星火/电信
  'XingChenAGI/Xing4.0-29B',
  // 汉仪？不是，meituan-longcat 已列
  // 蚂蚁百灵
  'inclusionAI/Ling-flash-2.0',
  'inclusionAI/Ling-mini-2.0',
];

// Kimi 官方可用模型（用户 Key 实测有权限的）
const KIMI_MODELS = [
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k3',
];

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyPlaceholder: 'sk-xxxxxxxx',
    browserDirect: true,
    models: SILICONFLOW_MODELS,
  },
  kimi: {
    label: 'Kimi 官方',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyPlaceholder: 'sk-xxxxxxxx（Kimi 官方 API key）',
    browserDirect: false, // 实测 CORS 不通过，需要说明
    extraHeaders: { 'kimi-api-version': '2026-09-01-beta' },
    models: KIMI_MODELS,
  },
};

/** 判断 AI 返回的值是否为空值占位词（不应写入表格） */
export function isEmptyValue(v: string): boolean {
  if (!v || !v.trim()) return true;
  const s = v.trim().toLowerCase();
  const empties = [
    '未提及', 'not mentioned', 'none', 'n/a', 'n\u200b/a', '无', '没有', '无法确定', '未能确定',
    'not available', 'not applicable', 'unknown', '不存在', '不适合', 'not provided',
  ];
  return empties.some((e) => s === e || s.startsWith(e) || s.endsWith(e));
}

/** 判断返回值是否仍是模板残留（如 [作者]、[年份]、……、...）或空括号 */
export function isTemplateResidue(v: string): boolean {
  if (!v || !v.trim()) return true;
  const s = v.trim();
  // 仍包含 [xxx] 占位符，说明 AI 没有替换
  if (/\[.+?\]/.test(s)) return true;
  // 包含连续省略号（半角 ... 或全角 ……），大概率是模板未填充
  if (/\.{2,}|…{2,}/.test(s)) return true;
  return false;
}

/** 简单文本归一化（去空白/标点/大小写），用于计算相似度 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\uff0c\u3002\u3001\uff1b\uff1a\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\uff08\uff09\(\)\[\]\{\}"'，。、；：！？!?]/g, '')
    .replace(/\.{2,}|…{2,}/g, '');
}

/** 判断返回值是不是原始描述的“回声”（AI 没提取，直接把提示词改几个字返回） */
export function isDescriptionEcho(value: string, description: string): boolean {
  if (!value || !description) return false;
  const v = value.trim();
  const d = description.trim();
  if (!v || !d) return false;
  // 如果返回值里还含着原始描述的核心片段（>6 个字符），直接视为回声
  const nd = normalizeText(d);
  const nv = normalizeText(v);
  if (nd.length >= 4) {
    // 描述是返回值的子串（AI 加了几个字但骨架没变）
    if (nv.includes(nd)) return true;
    // 描述与返回值编辑距离很近（归一化后长度接近且交集大）
    const commonLen = [...nv].filter((c) => nd.includes(c)).length; // 粗略公共字符数
    const ratio = Math.min(commonLen / (nd.length || 1), commonLen / (nv.length || 1));
    if (ratio > 0.6) return true;
  }
  return false;
}

/** 清理字段描述中的模板占位符（如“[作者]，发表于[期刊]” / “本文研究...机制”），避免 AI 把占位符原样输出 */
function sanitizeDescription(desc: string, fieldName: string): string {
  let s = (desc || '').trim();
  // 删除 [xxx] 占位符
  s = s.replace(/\[.+?\]/g, ' ').trim();
  // 把 .../…… 这类省略占位符替换为“具体”二字，提示 AI 这里需要填真实内容
  s = s.replace(/\.{2,}|…{2,}/g, '具体').trim();
  // 清理残余标点和多余空白
  s = s.replace(/[，,；;]+\s*[，,；;]+/g, '，').replace(/^[，,；;]+|[，,；;]+$/g, '').trim();
  // 兜底说明
  if (!s) return `从文献中提取“${fieldName}”的对应内容`;
  return s;
}

/** 动态构建提示词：把用户定义的字段名+描述一起传给 AI */
function buildPrompt(text: string, fields: TargetField[]): { system: string; user: string } {
  const fieldList = fields.map((f, i) => {
    const desc = sanitizeDescription(f.description, f.name);
    return `${i + 1}. 字段名：${f.name}\n   要求：${desc}`;
  }).join('\n');
  return {
    system: `你是一位学术文献阅读助手。下面是一份文献（论文、专著或整本书）经解析得到的全文文本，共 ${text.length} 个字符，可能存在解析噪声。请基于文本内容如实作答，禁止编造文本中没有的信息。`,
    user: `请从以下文献全文中提取以下字段的内容，严格输出 JSON（不要任何多余说明、不要 markdown 代码块以外的内容）。\n\n【字段列表】每个条目第一行是字段名（JSON 键名必须严格使用该字段名），第二行是该字段的提取要求：\n${fieldList}\n\n要求：\n- 所有字段值用简体中文填写（英文标题/作者/期刊名等专有名词保留原文）；\n- 若某字段在文中确实无法确定，值填 "未提及"；\n- 严禁全部字段都填 "未提及"，必须先从文本中认真提取；\n- JSON 键名只能是上面【字段列表】里的字段名，不能是描述文本；\n- 字段值中严禁出现任何 [xxx]、「……」、「...」等占位符或模板残留；
- 如果某个字段在文献中确实只有概括性描述、没有具体实质内容，请直接填 "未提及"，不要 Echo 原始描述。`,
  };
}

/** 容错解析模型返回的 JSON（处理 ```json 包裹、前后噪声、非 JSON 文本） */
export function parseFieldsJson(raw: string): Record<string, string> {
  let s = raw.trim();
  // 1. 剥离 ```json 代码块
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 2. 提取第一个 { 到最后一个 } 之间的内容
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    // 3. 如果仍然不是合法 JSON，返回 fallback
    return { _error: 'AI 未返回有效 JSON: ' + s.slice(0, 500) };
  }
}

/** 调用 chat/completions 提取字段（带重试） */
export async function extractFields(
  text: string,
  fields: TargetField[],
  cfg: AiConfig,
  signal?: AbortSignal
): Promise<{ fields: Record<string, string>; usage: any }> {
  const { system, user } = buildPrompt(text, fields);
  const provider = PROVIDERS[cfg.provider];
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    };
    if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);

    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 16384,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = new Error(`AI 接口错误 ${res.status}: ${body.slice(0, 300)}`);
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const fieldsResult = parseFieldsJson(content);
    const usage = data?.usage;
    if (fieldsResult._error) {
      lastError = new Error(fieldsResult._error);
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    return { fields: fieldsResult, usage };
  }
  throw lastError || new Error('AI 提取字段失败（未知错误）');
}
