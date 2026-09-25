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

// 硅基流动可用对话模型（按 2026-09-22 实测速度排序：14.7万字符单批提取
// DeepSeek-V4-Flash 10.7s ≪ GLM-5.2 76s ≪ Kimi-K2.7-Code 176s ≪ Qwen3.5-122B 247s）
const SILICONFLOW_MODELS = [
  // 实测最快·推荐（排第一=默认选中）
  'deepseek-ai/DeepSeek-V4-Flash',
  'deepseek-ai/DeepSeek-V3.2',
  'zai-org/GLM-5.2',
  // Kimi 系（实测较慢：14.7万字符单批约 3 分钟）
  'moonshotai/Kimi-K2.7-Code',
  'Pro/moonshotai/Kimi-K2.6',
  // 腾讯混元
  'tencent/Hy4-preview',
  // 智谱 GLM
  'zai-org/GLM-5.3',
  'zai-org/GLM-5.1',
  'Pro/zai-org/GLM-5.1',
  // DeepSeek
  'deepseek-ai/DeepSeek-V4-Pro',
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
    // 2026-09-22 实测：CORS 预检已放行（allow-origin 回显请求 origin）。
    // 注意：不能再带自定义头 kimi-api-version —— 带了它预检就不返回 allow-headers，
    // 浏览器会拦截整个请求（之前"CORS 不通过"的根因就是这个头）。
    browserDirect: true,
    models: KIMI_MODELS,
  },
};

/**
 * 模型下拉框显示名：给实测结论加标注
 */
export function modelLabel(m: string): string {  if (m === 'deepseek-ai/DeepSeek-V4-Flash') return `${m}（实测最快·推荐）`;
  // 所有 Kimi K2/K3 系模型实测解码慢（单批 14.7万字符约 3 分钟），一律标注
  if (/kimi/i.test(m)) return `${m}（实测慢·约 3 分钟/批，建议用硅基流动 + DeepSeek-V4-Flash）`;
  return m;
}

/** 判断 AI 返回的值是否为空值占位词（不应写入表格） */
export function isEmptyValue(v: string): boolean {
  if (!v || !v.trim()) return true;
  const s = v.trim().toLowerCase();
  // 精确/前后缀匹配的短占位词
  const empties = [
    '未提及', 'not mentioned', 'none', 'n/a', 'n\u200b/a', '无', '没有', '无法确定', '未能确定',
    'not available', 'not applicable', 'unknown', '不存在', '不适合', 'not provided', '暂无',
    '无作者信息', '无相关信息', '无有效信息', '无内容',
  ];
  if (empties.some((e) => s === e || s.startsWith(e) || s.endsWith(e))) return true;
  // 包含式匹配的“推脱话术”（如“未提供文献全文”“文中未提及作者”“无法从文献中提取”）
  const refusals = [
    '未提供', '未给出', '未说明', '未明确', '未提及', '未涉及', '未找到', '未包含',
    '文中未', '文献未', '文献中未', '无法提取', '无法判断', '无法从文献', '没有提供',
    '没有提到', '未见', '缺少相关', '不包含', 'not mentioned in', 'not found in', 'not specified',
    // AI 拒答/客套话（如“很抱歉，我无法访问互联网或搜索引擎…”），绝不写入表格
    '很抱歉', '抱歉，我', '无法访问互联网', '无法访问网络', '无法联网',
    '作为ai', '作为一个ai', 'i cannot', "i can't", 'i apologize', 'as an ai', 'cannot access the internet',
  ];
  return refusals.some((r) => s.includes(r));
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

/** 是否为「英文标题」类字段：纯中文文献没有英文标题，"无"是合法终值 */
export function isEnglishTitleField(fieldName: string): boolean {
  const n = (fieldName || '').trim().toLowerCase();
  return n.includes('英文标题') || n.includes('英文题名') || /english\s*title|original\s*title/i.test(n);
}

/** 是否为标题类字段（英文标题/中文标题/中文题目等）：提取质量要求最高 */
export function isTitleField(fieldName: string): boolean {
  const n = (fieldName || '').trim().toLowerCase();
  return n.includes('标题') || n.includes('题名') || n.includes('题目') || /title/i.test(n);
}

/** 是否为「关键词」类字段：只允许原文 Keywords 栏里的术语 */
export function isKeywordField(fieldName: string): boolean {
  const n = (fieldName || '').trim().toLowerCase();
  return n.includes('关键词') || n.includes('关键字') || /keywords?/i.test(n);
}

/** 是否为「摘要」类字段（含一句话摘要）：必须概括研究内容本身 */
export function isAbstractField(fieldName: string): boolean {
  const n = (fieldName || '').trim().toLowerCase();
  return n.includes('摘要') || /abstract|summary/i.test(n);
}

/** 是否为「相关文献/参考文献」类字段：只允许原文 References 列表里真实存在的条目 */
export function isRelatedWorkField(fieldName: string): boolean {
  const n = (fieldName || '').trim().toLowerCase();
  return n.includes('相关文献') || n.includes('参考文献') || /related\s*work|references?\b/i.test(n);
}

/** 判断值是否是 AI 的"搜索式编造/操作指引"垃圾（如"根据您的要求，我通过“文章标题”搜索…"、"以下信息是虚构"）。
 *  与 isEmptyValue 的拒答词互补：这里抓的是"假装帮用户搜索/承认虚构/教用户怎么搜"的话术。 */
export function looksLikeFabrication(v: string): boolean {
  const s = (v || '').trim();
  if (!s) return false;
  const markers = [
    '根据您的要求', '以下信息是虚构', '并不代表真实的论文', '基于假设的，并不代表',
    '仅供参考。如果您需要真实', '你可以按照上述步骤', '建议您访问', '建议您使用',
    '搜索结果会显示', '打开google scholar', '在搜索框中输入', '我通过“', '我通过"',
    'ndltd.ncl.edu.tw', 'airitilibrary.com', '无法直接访问互联网数据库', '进行实时搜索',
    // v6.13.1 补充变体（2026-09-25 实测漏网案例）：
    '无法直接访问互联网进行实时搜索', '无法直接访问互联网或搜索实时数据库',
    '无法直接搜索互联网或访问外部数据库', '建议直接访问相关的学术数据库',
    '无法直接访问互联网和实时数据库', '基于您提供的参考数据', '这些信息是基于您提供的',
    '示例，这些信息', '标题和发表年份的示例', '链接和发表年份的示例', '真实链接和发表年份',
  ];
  return markers.some((m) => s.toLowerCase().includes(m.toLowerCase()));
}

/** 标题防呆版本：v2 起标题"无"/引文串必须经过单字段精读确认后才算终值。
 * 低于此版本的缓存/表格旧数据里的标题"无"不可信（可能是 v6.9 之前 AI 敷衍写入的），需复核一次。 */
export const TITLE_GUARD_VER = 2;

/** 标题类字段值是否需要复核（"无" 或 引文/出处串）：未经防呆确认前一律视为可疑 */
export function titleNeedsRecheck(fieldName: string, v: string | null | undefined): boolean {
  if (!isTitleField(fieldName)) return false;
  const s = (v == null ? '' : String(v)).trim();
  return s === '无' || looksLikeCitation(s);
}

/** 判断值是否像"引文/出处串"而不是标题（如 "P. Araya et al., Automation in Construction, 175 (2025) 106170"） */
export function looksLikeCitation(v: string): boolean {
  const s = (v || '').trim();
  if (!s) return false;
  if (/et al\.?/i.test(s)) return true;                      // 含 "et al."
  if (/,\s*\d+\s*\(\d{4}\)/.test(s)) return true;            // "175 (2025)" 卷(年份)
  if (/\(\d{4}\)\s*[:：]?\s*\d{4,}/.test(s)) return true;    // "(2025) 106170" 文章号
  if (/\bdoi\b|10\.\d{4,}\//i.test(s)) return true;          // DOI
  if (/\bissn\b|\bisbn\b/i.test(s)) return true;             // ISSN/ISBN
  if (/\bno\.\s*\d+.*\(\w+\s*\d{4}\)/i.test(s)) return true; // "No. 34 (July 2024)" 刊期号
  if (/\d{4}年\d{1,2}月|投稿.{0,6}\d{4}年/.test(s)) return true; // "2024年2月投稿/出版时间" 出版流程串
  if (/[《][^》]+[》][，,].*版社/.test(s)) return true;       // "书名，出版社，出版时间" 版权页串
  return false;
}

/** 特殊字段归一化：英文标题提取结果不含英文字母（纯中文/书名号包中文书名）→ 视为没有英文标题，统一写「无」 */
export function normalizeSpecialFieldValue(fieldName: string, v: string): string {
  if (isEnglishTitleField(fieldName)) {
    const s = (v || '').trim().replace(/^《+|》+$/g, '').trim();
    if (!s) return '无';
    if (s !== '无' && !/[a-zA-Z]/.test(s)) return '无';
    return s;
  }
  return v;
}

/** 值是否是"署名/版权页式元数据串"（大量"标签：内容"片段组成的污染值，如摘要/关键词被写成
 *  "作者：xxx；单位：xxx；期刊：xxx；DOI：xxx"）。摘要/关键词命中 → 无效，触发重提。 */
export function looksLikeMetadataDump(fieldName: string, v: string): boolean {
  // 只对摘要/关键词类字段生效（基础信息/文章信息类字段本来就允许元数据）
  if (!isAbstractField(fieldName) && !isKeywordField(fieldName)) return false;
  const s = (v || '').trim();
  if (!s) return false;
  // 统计"标签："模式（中英文冒号都算）：按分隔符切段，每段开头命中标签表即计一次
  const labels = ['作者', '单位', '通讯作者', '期刊', '发表', '出版', '出版社', '版权', 'ISBN', 'DOI', '卷', '期', '页码', '字数', '丛书', '数据库', '文献来源', 'Corresponding author', 'Affiliation', 'Volume', 'Issue'];
  const segs = s.split(/[，,；;。.\n]/);
  let labelCount = 0;
  for (const seg of segs) {
    const t = seg.trim().toLowerCase();
    if (!t) continue;
    for (const lb of labels) {
      if (t.startsWith(lb.toLowerCase() + '：') || t.startsWith(lb.toLowerCase() + ':')) { labelCount++; break; }
    }
  }
  if (labelCount >= 3) return true; // 3 个以上"标签："→ 元数据罗列，不是内容概括
  return false;
}

/** 字段值是否为有效终值（可直接写入表格 / 视为"已提取"）。
 * 注意：「英文标题」的"无"是合法终值（确实没有英文标题），不能再当成空值反复重提。 */
export function isFieldValueValid(fieldName: string, v: string | null | undefined, description = ''): boolean {
  const s = v == null ? '' : (typeof v === 'string' ? v : String(v)).trim();
  if (!s) return false;
  if (isEnglishTitleField(fieldName) && s === '无') return true;
  // 标题类字段返回了引文/出处串（AI 把引用格式当标题）→ 无效
  if (isTitleField(fieldName) && looksLikeCitation(s)) return false;
  if (isEmptyValue(s) || isTemplateResidue(s)) return false;
  // AI 的"搜索式编造/操作指引"垃圾（伪装搜索结果、承认虚构、教用户去 Google Scholar）
  if (looksLikeFabrication(s)) return false;
  // 摘要/关键词被写成"作者：xxx；单位：xxx"式元数据罗列 → 无效，触发重提
  if (looksLikeMetadataDump(fieldName, s)) return false;
  if (description && isDescriptionEcho(s, description)) return false;
  return true;
}

/** 危险提示词检测：字段描述里命令 AI 联网搜索/输出链接，这正是"编造文献"的源头。
 *  命中则丢弃用户描述，改用安全的默认指令。 */
function overrideDangerousDescription(desc: string, fieldName: string): { desc: string; overridden: boolean } {
  const s = (desc || '').trim();
  const dangerous = [
    '搜索', 'search', '检索', 'google scholar', '开源数据库', '数据库搜索',
    '链接', '网址', 'url', 'http', '网上', '联网', '实时', '导入文献管理系统',
  ];
  const hit = dangerous.some((d) => s.toLowerCase().includes(d));
  const defaults: Record<string, string> = {
    related_work: '从文献文末的参考文献（References）列表中，挑选与本文献主题最相关的 3-5 条文献，按原文著录格式逐条列出（作者. 标题. 出处. 年份）；只允许列表中真实存在的条目',
    keyword: '提取文献原文 Keywords（关键词）栏中的术语；外文关键词译成中文；原文没有 Keywords 栏时填“未提及”',
  };
  let kind = '';
  if (isRelatedWorkField(fieldName)) kind = 'related_work';
  else if (isKeywordField(fieldName)) kind = 'keyword';
  // 用户的描述命令联网搜索 → 一律覆盖为安全指令
  if (kind && hit) return { desc: defaults[kind], overridden: true };
  if (isRelatedWorkField(fieldName) && !s) return { desc: defaults.related_work, overridden: true };
  return { desc: s, overridden: false };
}

/** 清理字段描述中的模板占位符（如"[作者]，发表于[期刊]" / "本文研究...机制"），避免 AI 把占位符原样输出 */
function sanitizeDescription(desc: string, fieldName: string): string {
  let s = (desc || '').trim();
  // 删除 [xxx] 占位符
  s = s.replace(/\[.+?\]/g, ' ').trim();
  // 把 .../…… 这类省略占位符替换为“具体”二字，提示 AI 这里需要填真实内容
  s = s.replace(/\.{2,}|…{2,}/g, '具体').trim();
  // 清理残余标点和多余空白
  s = s.replace(/[，,；;]+\s*[，,；;]+/g, '，').replace(/^[，,；;]+|[，,；;]+$/g, '').trim();
  // 相关文献/关键词类字段：描述里含"联网搜索"等危险指令 → 覆盖为安全默认指令（防 AI 编造文献）
  const ov = overrideDangerousDescription(s, fieldName);
  if (ov.overridden) return ov.desc;
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
  // 英文标题类字段：纯中文文献没有英文标题，必须填"无"，严禁拿中文标题凑数
  const etFields = fields.filter((f) => isEnglishTitleField(f.name));
  const etRule = etFields.length
    ? `\n- ${etFields.map((f) => `「${f.name}」`).join('、')}：如果文献本身没有英文（外文）标题（如纯中文论文、中文书籍），该字段值必须填 "无"，严禁把中文标题或中文书名当作英文标题填入；有英文标题时保留英文原文。`
    : '';
  // 标题类字段：必须是文献自身的标题，严禁把引文/出处串/特刊节点名当标题
  const titleFields = fields.filter((f) => isTitleField(f.name) && !isEnglishTitleField(f.name));
  const titleRule = titleFields.length
    ? `\n- ${titleFields.map((f) => `「${f.name}」`).join('、')}：必须输出文献自身的标题（通常在首页/封面最显眼处、通常字号最大的一行文字）；字段名含"中文"的（如中文题目/中文标题）外文标题必须翻译成通顺的简体中文，字段名含"英文"的必须保留英文原文，其他普通标题字段外文文献也请翻译成通顺的简体中文；严禁输出以下内容充当标题：①引文/出处串（含 "et al."、期刊名+卷(年份)+页码、DOI、ISSN）；②期刊的特刊/专题/栏目（节点）名称——那是期刊这一期的话题名，不是本文的标题（例如论文标题行通常紧挨作者名，出现在特刊名之后）；③书名号里的中文书名（对论文类文献而言）。如果正文里找不到本文标题，填 "无"，不要拿别的东西凑数。`
    : '';
  // 关键词字段：只允许原文 Keywords 栏里的术语
  const kwFields = fields.filter((f) => isKeywordField(f.name));
  const kwRule = kwFields.length
    ? `\n- ${kwFields.map((f) => `「${f.name}」`).join('、')}：只填原文 Keywords（关键词）栏中列出的术语（通常紧跟摘要之后，多条用分号或顿号分隔）；外文关键词翻译成中文；文献自己提出的关键概念可适当补充，但严禁把以下内容当关键词：作者姓名、期刊名、发表年份、数据库名、文献篇数、投稿/出版日期、出版社、ISBN、"Materiology and Variantology" 这类特刊/栏目名（那是期刊话题名不是本文关键词）。若原文没有 Keywords 栏，填 "未提及"。`
    : '';
  // 摘要字段：概括研究内容本身，严禁元数据
  const absFields = fields.filter((f) => isAbstractField(f.name) && !looksLikeFabrication(f.name));
  const absRule = absFields.length
    ? `\n- ${absFields.map((f) => `「${f.name}」`).join('、')}：概括文献的研究内容本身（研究问题、方法、主要发现/结论），80-200 字；严禁把以下元数据写进摘要：作者名、期刊名、卷期年份、投稿/接收/出版日期、出版社、ISBN、数据库名、文献篇数、书名页/版权页信息。摘要内容必须能在【文献全文】中找到依据，不得与${fields.some((f) => f.name.includes('基础信息')) ? '「基础信息」' : '其他书目信息'}重复。`
    : '';
  // 相关文献字段：只允许原文 References 里真实存在的条目
  const rwFields = fields.filter((f) => isRelatedWorkField(f.name));
  const rwRule = rwFields.length
    ? `\n- ${rwFields.map((f) => `「${f.name}」`).join('、')}：从文末参考文献（References）列表中挑出最相关的 3-5 条，逐条列出"作者. 标题. 出处. 年份"，格式参考原文献的著录方式（如 GB/T 7714 或文中既有格式）；严禁编造原文参考文献列表中不存在的文献；严禁插入任何互联网搜索行为、操作指引（"打开 Google Scholar"等）或"无法访问互联网"之类的说明——你手上就是全文，文末就有真实参考文献。若确实无参考文献栏，填 "未提及"。`
    : '';
  return {
    system: `你是一位学术文献阅读助手。下面是一份文献（论文、专著或整本书）经解析得到的全文文本，共 ${text.length} 个字符，可能存在解析噪声。请基于文本内容如实作答，禁止编造文本中没有的信息。你没有联网能力，也不需要联网——所有答案都在文本里。`,
    user: `请从以下文献全文中提取以下字段的内容，严格输出 JSON（不要任何多余说明、不要 markdown 代码块以外的内容）。\n\n【字段列表】每个条目第一行是字段名（JSON 键名必须严格使用该字段名），第二行是该字段的提取要求：\n${fieldList}\n\n要求：\n- 提取的内容必须真实来自【文献全文】：字段值中的每个事实（人名/数据/结论）都要能在原文中找到出处，严禁凭空编造或用外部知识补齐；\n- 所有字段值用简体中文填写（英文标题/作者/期刊名等专有名词保留原文）；\n- 若某字段在文中确实无法确定，值填 "未提及"；\n- 严禁全部字段都填 "未提及"，必须先从文本中认真提取；\n- JSON 键名只能是上面【字段列表】里的字段名，不能是描述文本；\n- 字段值中严禁出现任何 [xxx]、「……」、「...」等占位符或模板残留；
- 如果某个字段在文献中确实只有概括性描述、没有具体实质内容，请直接填 "未提及"，不要 Echo 原始描述。
- 空值只能填 "未提及" 这一个词，严禁自己编造"未提供文献全文""无作者信息""文中未找到"之类的说明性文字作为字段值。
- 内容要具体、有信息量：写出关键方法名、数据、对象、结论要点等细节，不要一句话空泛带过；字段要求里有字数上限的，在上限内尽量写充实。${etRule}${titleRule}${kwRule}${absRule}${rwRule}

【文献全文】
${text}`,
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

/** 调用单次 chat/completions 提取一批字段
 * @param deep 精读模式：只提一个字段时，要求模型认真通读全文、严格按该字段提示词提取 */
async function callOnce(
  text: string,
  fields: TargetField[],
  cfg: AiConfig,
  signal?: AbortSignal,
  deep = false
): Promise<{ fields: Record<string, string>; usage: any; raw: string }> {
  let system: string, user: string;
  if (deep && fields.length === 1) {
    const f = fields[0];
    const desc = sanitizeDescription(f.description, f.name);
    system = `你是一位严谨的学术文献阅读助手。下面是一份文献经解析得到的全文文本（共 ${text.length} 个字符，可能有解析噪声）。请先认真通读整篇文献，再提取指定的这一个字段，严禁编造文本中没有的信息。`;
    const etRule = isEnglishTitleField(f.name)
      ? `\n- 特别规则：如果该文献本身没有英文（外文）标题（如纯中文论文、中文书籍），只填 "无" 一个词，严禁把中文标题或中文书名当作英文标题；有英文标题时保留英文原文。`
      : '';
    // 标题类字段：只输出标题本身，严禁引文/出处串/特刊节点名/版权页串
    const titleRule = isTitleField(f.name) && !isEnglishTitleField(f.name)
      ? `\n- 特别规则：只输出文献自身的标题本身（通常在首页/封面最显眼处、通常字号最大的独立一行，紧挨作者名之前或之后），外文文献翻译成通顺简体中文；严禁把以下内容当标题：引文/出处串（et al./卷(年份)/DOI/ISSN）、期刊特刊/专题（节点）名称、报告编号、"No. 34 (July 2024)" 刊期号、版权页字符串。若确实找不到本文标题，只填 "无"。`
      : '';
    // 关键词/摘要/相关文献的精读专项规则
    const kwRule = isKeywordField(f.name)
      ? `\n- 特别规则：只填原文 Keywords（关键词）栏中的术语（外文关键词翻译成中文）；严禁把作者/期刊/年份/数据库名/特刊名当关键词；原文没有 Keywords 栏时只填 "未提及"。`
      : '';
    const absRule = isAbstractField(f.name)
      ? `\n- 特别规则：概括研究内容本身（问题/方法/发现），80-200 字；严禁写作者名、期刊/出版社、投稿出版日期、ISBN 等任何元数据。`
      : '';
    const rwRule = isRelatedWorkField(f.name)
      ? `\n- 特别规则：从文末 References 列表挑最相关的 3-5 条原样著录；严禁编造文献、严禁任何搜索指引或拒答话术；无 References 栏时只填 "未提及"。`
      : '';
    user = `请从以下文献全文中，严格按下方要求提取唯一字段「${f.name}」的内容。\n\n【本字段的提取要求】\n${desc}\n\n提取规则：\n- 用简体中文填写（专有名词如作者/期刊/机构名保留原文）；\n- 必须先通读全文、定位与该字段相关的所有信息，再综合给出最准确、最完整的答案；\n- 内容要具体、有信息量，写出关键方法名、数据、对象、结论要点等细节，不要一句话空泛带过；\n- 若文中确实完全没有该字段相关信息，只填 "未提及" 一个词，严禁自己编造"未提供文献全文""文中未找到"等说明性文字；\n- 答案中严禁出现 [xxx]、「……」、「...」等占位符；\n- 直接输出该字段的值（一句话或一段，无需 JSON 包裹、无需重复字段名）。${etRule}${titleRule}${kwRule}${absRule}${rwRule}\n\n【文献全文】\n${text}`;
  } else {
    ({ system, user } = buildPrompt(text, fields));
  }
  const provider = PROVIDERS[cfg.provider];
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
    throw new Error(`AI 接口错误 ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  if (deep) {
    // 精读模式：模型按指令直接输出该字段的值（纯文本），不包 JSON
    const v = content.trim();
    return { fields: { [fields[0].name]: v }, usage: data?.usage, raw: v };
  }
  const fieldsResult = parseFieldsJson(content);
  if (fieldsResult._error) throw new Error(fieldsResult._error);
  return { fields: fieldsResult, usage: data?.usage, raw: content };
}

/** 提取模式：all=全部字段一次提取（快）；chunk=每批7个（均衡）；single=单字段逐个（最准、最慢） */
export type ExtractMode = 'all' | 'chunk' | 'single';

/**
 * 按模式分批提取字段，逐批调用 AI 后合并结果。
 * 单批失败（重试 2 次后）跳过不影响其他批，全部失败才报错。
 */
export async function extractFields(
  text: string,
  fields: TargetField[],
  cfg: AiConfig,
  signal?: AbortSignal,
  mode: ExtractMode = 'chunk'
): Promise<{ fields: Record<string, string>; usage: any; raws: string[] }> {
  const CHUNK = mode === 'all' ? fields.length : mode === 'single' ? 1 : 7;
  const deep = mode === 'single';
  const chunks: TargetField[][] = [];
  for (let i = 0; i < fields.length; i += CHUNK) {
    chunks.push(fields.slice(i, i + CHUNK));
  }

  const merged: Record<string, string> = {};
  const raws: string[] = [];
  let usage: any;
  let lastError: Error | null = null;
  let okChunks = 0;

  /** 单批提取（带 2 次重试），返回是否成功 */
  const runChunk = async (chunk: TargetField[]): Promise<boolean> => {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const r = await callOnce(text, chunk, cfg, signal, deep);
        Object.assign(merged, r.fields);
        usage = r.usage;
        raws.push(`【批次：${chunk.map((f) => f.name).join('、')}】\n${r.raw}`);
        okChunks += 1;
        lastError = null;
        return true;
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return false;
  };

  // 并行执行批次（最多 4 个同时进行），大幅缩短总耗时；abort 时立即抛出
  const CONCURRENCY = 4;
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      await runChunk(chunk);
    }
  });
  await Promise.all(workers);

  if (okChunks === 0) {
    throw lastError || new Error('AI 提取字段失败（所有批次均失败）');
  }
  return { fields: merged, usage, raws };
}

/**
 * 智能分段提取：全文超过单段上限时自动切段，后续段落只补提取仍缺的字段。
 * - 第 1 段按指定模式提取全部字段；
 * - 第 2 段起只提取第 1 段没拿到的字段（空值/未提及/模板残留都算缺）；
 * - 所有字段都齐了立即停止，不读后面的段（长书通常前 1-2 段就够）；
 * - 段间留少量重叠字符，避免句子/章节在切分边界被截断。
 */
export async function extractFieldsAuto(
  text: string,
  fields: TargetField[],
  cfg: AiConfig,
  signal?: AbortSignal,
  mode: ExtractMode = 'chunk',
  onProgress?: (segIndex: number, segTotal: number) => void
): Promise<{ fields: Record<string, string>; raws: string[] }> {
  const SEG = 140000;
  const OVERLAP = 1500;

  if (text.length <= SEG) {
    const r = await extractFields(text, fields, cfg, signal, mode);
    return { fields: r.fields, raws: r.raws };
  }

  // 切段（带重叠）
  const segs: string[] = [];
  for (let i = 0; i < text.length; i += SEG) {
    segs.push(text.slice(i, i + SEG + OVERLAP));
  }

  const merged: Record<string, string> = {};
  const raws: string[] = [];

  for (let si = 0; si < segs.length; si++) {
    onProgress?.(si + 1, segs.length);
    // 仍缺的字段：空/未提及/模板残留/描述回声都视为没拿到
    const missing = fields.filter((f) => {
      const v = merged[f.name];
      if (!v || !v.trim() || isEmptyValue(v) || isTemplateResidue(v)) return true;
      return isDescriptionEcho(v, f.description);
    });
    if (!missing.length) break;

    const r = await extractFields(segs[si], missing, cfg, signal, mode);
    Object.assign(merged, r.fields);
    raws.push(...r.raws.map((s) => `【第 ${si + 1}/${segs.length} 段】\n${s}`));
  }

  return { fields: merged, raws };
}
