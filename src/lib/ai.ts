// AI 生成层：支持多平台 OpenAI 兼容接口
export interface TargetField {
  name: string;       // 字段名
  fieldId: string;    // 字段 ID（用于写回）
  description: string; // 字段描述（可选，来自表里的"提示词"或字段名本身）
}

/** 提取结果通用结构 */
export interface ExtractResult {
  fields: Record<string, string>;
  raws: string[];
  /** 从原文末尾切出的 References / 参考文献 区块，用于相关文献正向校验 */
  referencesText: string;
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
  // 仍包含 [xxx] 占位符，说明 AI 没有替换；但 [1]/[12] 这类纯数字编号是合法引用格式，不算占位
  if (/\[[^\d\s]+?\]/.test(s)) return true;
  // 包含连续省略号（半角 ... 或全角 ……），大概率是模板未填充
  if (/\.{2,}|…{2,}/.test(s)) return true;
  return false;
}

/** 剥离模型推理标签：部分模型会在正文里夹带 <think:6124c78e>...</think:6124c78e> 或裸 </think>/<think>，
 * 若不清理会直接污染字段值（如"公共艺术的观念与方法</think>公共艺术的观念与方法"）。 */
export function stripThinkTags(s: string): string {
  if (!s) return s;
  return s
    .replace(/<think:6124c78e>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<\/?think>/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 简单文本归一化（去空白/标点/大小写），用于计算相似度 */
export function normalizeText(s: string): string {
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
    // v6.16.1 补充：专著无 References 栏时 AI 用外部知识/网页搜索凑数的话术与假源
    '未提供年份', '年份未提供', '年份信息未提供', '出版年份未提供',
    '维基百科', 'wikipedia', 'wiki', 'public art 101', 'from concept to commission',
    'national civic league', ' Americans for the Arts', '(pdf)', '[pdf]', 'pdf 全文',
    '相关链接', '链接如下', '参考链接', '请.*注意.*链接', '请.*查看.*链接',
    '访问以下', '参见以下', '详见以下', '更多.*参考', '以下网站', '以下网址', '网上资料',
    '(n.d.)', 'no date', 'no. ', 'pp. ', 'eds.', 'ed.', 'isbn:',
  ];
  if (markers.some((m) => s.toLowerCase().includes(m.toLowerCase()))) return true;
  // v6.14 结构化拒答识别（正则模式而非枚举）：AI 每轮都会换新措辞，枚举永远追不完。
  // 拒答/操作指引的"结构"是稳定的：道歉+无法联网 / 无法+访问搜索+互联网数据库 / 建议+使用搜索引擎。
  const lower = s.toLowerCase();
  const refusalPatterns = [
    /抱歉[^。]{0,50}(无法|不能|请(您)?(使用|通过|访问|打开|输入))/,
    /(无法|不能)[^。]{0,25}(访问|搜索|联网|链接|连接|打开)[^。]{0,25}(互联网|网络|数据库|网页|网站|外部|实时)/,
    /(建议|请您|可以帮|帮你|我可以)[^。]{0,25}(使用|通过|访问|打开|输入)[^。]{0,30}(搜索引擎|学术搜索|数据库|google|谷歌|百度学术|ieee|pubmed|scholar)/,
  ];
  return refusalPatterns.some((p) => p.test(lower));
}

/** 是否为「作者」类字段（不含"作者单位"这类机构字段） */
export function isAuthorField(fieldName: string): boolean {
  const n = (fieldName || '').trim().toLowerCase();
  return (n.includes('作者') && !n.includes('单位')) || /(^|\b)authors?\b/.test(n);
}

/** 从文献全文末尾切出 References / Bibliography / 参考文献 区块（约 80 万字符）。
 *  用于相关文献正向校验：只有出现在这个区块里的条目，才允许写入表格。 */
export function extractReferencesBlock(text: string): string {
  if (!text) return '';
  // 找 References / Bibliography / 参考文献 标题；优先英文，中文兜底
  const m = text.match(/(?:^|\n)(?:References|REFERENCES|Bibliography|BIBLIOGRAPHY|参考文献|参考文獻)\s*\n([\s\S]{0,800000})/im);
  let block = m ? m[1] : '';
  // 截断到下一个章节标题之前（如 "Appendix"、"Acknowledgements"、下一个 "\n\d+\. " 主标题）
  const stop = block.search(/\n(?=Appendix|Acknowledgements|Acknowledgments|Author contributions|Funding|Conflict of interest|Data availability|Supplementary|Figure|Table|注释|致谢|附录|第[一二三四五六七八九十\d]+章)/i);
  if (stop > 100) block = block.slice(0, stop);
  return block.trim();
}

/** 把相关文献值拆成若干独立条目 */
function splitRelatedWorkItems(v: string): string[] {
  const s = (v || '').trim();
  if (!s) return [];
  // 先按 markdown 列表 / 编号 / 换行拆分常见形态
  const items = s
    .split(/\n+/)
    .map((x) => x.replace(/^\s*[-•*]+\s*/, '').replace(/^\s*\d+\s*[.、．)\]]\s*/, '').trim())
    .filter(Boolean);
  if (items.length >= 2) return items;
  // 没有换行则按分号拆
  const semi = s
    .split(/[；;]/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 8);
  if (semi.length >= 2) return semi;
  return [s];
}

/** 计算一个文献条目与原文 References 区块的命中强度。
 *  优先匹配 "标题"（长连续字母/中文词）或 "第一作者姓"；任一核心标识在 References 块中即命中。 */
function itemHit(item: string, refBlock: string): boolean {
  const ref = refBlock.toLowerCase();
  const items = item.toLowerCase();
  // 0. 整句/整条目在 References 里（部分 AI 会原样著录）
  if (ref.includes(items) || items.includes(ref.slice(0, 120))) return true;
  // 1. 提取疑似标题：最长的一段连续非标点文字（通常是论文标题 or 书名）
  const titleLike = item.match(/[a-z0-9\u4e00-\u9fa5]{4,}(?:\s+[a-z0-9\u4e00-\u9fa5]+){1,}/gi) || [];
  for (const t of titleLike) {
    if (t.length >= 8 && ref.includes(t.toLowerCase())) return true;
  }
  // 2. 提取第一作者姓氏：开头 "Baumeister," / "N. Catbas," / "Marburger," / "孙振华"
  const author = item.match(/^\s*([A-Z][a-z]+|[\u4e00-\u9fa5]{2,4})/);
  if (author) {
    const family = author[1].toLowerCase();
    // 姓氏在 References 块中多处出现，更可信
    if ((ref.match(new RegExp('\\b' + family + '\\b', 'g')) || []).length >= 1) return true;
  }
  // 3. DOI 匹配
  const doi = item.match(/10\.\d{4,}\/[^\s\])}]+/);
  if (doi && ref.includes(doi[0].toLowerCase())) return true;
  return false;
}

/** 判断值是否是"外部知识/网页搜索式参考书目"（专著无 References 栏时 AI 常编造）。
 *  命中任意一条 → 直接判为编造，不允许写入相关文献字段。 */
function looksLikeWebBibliography(v: string): boolean {
  const s = (v || '').trim().toLowerCase();
  if (!s) return false;
  // 1. 包含明显的网页/外部链接或通用知识型短语
  const webMarkers = [
    'http', 'https', 'www.', '.com', '.org', '.net', '.gov', '.edu', '.cn',
    'wikipedia', 'wiki', 'public art 101', 'from concept to commission', 'national civic league',
    'americans for the arts', 'unesco', 'creative city', 'creative cities',
    // v6.16.2：常见学术搜索/数据库域名（AI 常在这些平台编造搜索推荐）
    'scholar.google', 'webofscience.com', 'web of science', 'scopus.com', 'scopus', 'cnki.net',
    'cnki', 'jstor.org', 'jstor', 'pubmed', 'ieee', 'researchgate', 'springer', 'elsevier',
    'mdpi', 'arxiv.org', 'arxiv', 'ssrn',
  ];
  if (webMarkers.some((m) => s.includes(m))) return true;
  // 2. 包含 "(n.d.)" / "(nd)" / "no date" 等无年份占位（真实书目极少这样著录）
  if (/\(n\.d\.\)|\(nd\)|no date|year unknown|unknown year|年份未提供|未提供年份|无年份|不详/.test(v)) return true;
  // 3. 含 "参见" / "可参考" / "更多阅读" / "网上" 等指引词
  if (/参见|可参考|更多阅读|延伸阅读|网上|网站|网址|链接|下载|pdf全文|pdf文档|电子书/.test(v)) return true;
  // 4. 条目格式像 "书名. 网站名. (n.d.)" 这种外部推荐
  if (/[《"'].*?[》"'].*?(网站|网|平台|数据库|library|archive|foundation|council|league|101)/i.test(v)) return true;
  return false;
}

/** 相关文献值结构 + 正向校验。
 *  合法值必须：
 *   1) 是"多条目列表"（换行/编号/分号分隔）；
 *   2) 至少 N 条能在原文 References 区块里找到依据（命中标题/作者/DOI）。
 *  无 References 栏的专著只能返回 "未提及"/"无"/空；任何带外部链接/网页搜索/Wikipedia/年份占位的列表都视为编造。 */
export function isRelatedWorkValuePlausible(v: string, refBlock?: string): boolean {
  const s = (v || '').trim();
  if (!s) return false;
  if (s === '未提及' || s === '无') return true;
  // 全文级别拒答/编造/操作指引（比条目级更稳，如 example.com 假链接+"请注意以上为示例"）
  if (looksLikeFabrication(s) || looksLikeWebBibliography(s) || isEmptyValue(s)) return false;
  // v6.16.6：任何包含 URL/搜索链接形态的相关文献值直接判无效（example.com、zhihu.com、x-mol.com、google.com 搜索等）
  if (/https?:\/\/|www\.|\.com|\.org|\.net|\.gov|\.edu|\.cn|scholar\.google|zhihu\.com|x-mol\.com|zhangqiaokeyan\.com/i.test(s)) return false;
  const items = splitRelatedWorkItems(s);
  if (items.length < 2) return false;                                  // 单段散文/单条 → 不是文献列表

  // 未提供 References 文本（比如旧调用或专著没有 References）→ 只允许 "未提及"/"无"/空；
  // 任何看起来是"参考书目列表"的值都视为 AI 编造/外部知识凑数。
  if (!refBlock || refBlock.length < 20) return false;

  // 至少 2 条命中，或命中率 ≥40%，且没有明显搜索/编造话术
  let hits = 0;
  for (const it of items) {
    if (looksLikeFabrication(it) || looksLikeWebBibliography(it) || isEmptyValue(it)) return false;
    if (itemHit(it, refBlock)) hits++;
  }
  const ratio = hits / items.length;
  if (hits >= 2 && ratio >= 0.4) return true;
  return false;
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

/** 判断值是否是期刊/专著的"专题节点/特刊/栏目名"而不是论文本身的标题。
 *  典型：baseInfo 里写"所属专题节点：Materiology and Variantology: invitation to dialogue"，
 *  AI 却把专题节点名填进"英文标题/中文题目"。 */
export function isSpecialIssueNodeTitle(v: string, baseInfo?: string): boolean {
  const s = (v || '').trim();
  if (!s || !baseInfo) return false;
  const info = baseInfo.toLowerCase();
  // 基础信息里明确提到"专题节点""special issue""collection""特刊""专栏"等
  if (!/专题节点|special\s*issue|特刊|专栏|collection|section| тема|monographic/i.test(info)) return false;
  // 标题值与基础信息中的节点名高度重合（通常节点名很长且带冒号，直接子串包含）
  const ns = normalizeText(s);
  const ni = normalizeText(baseInfo);
  if (ns.length >= 6 && (ni.includes(ns) || ns.includes(ni.slice(0, Math.min(ni.length, ns.length + 20))))) return true;
  // 标题本身像"主题+invitation/call for"这类会议/特刊召集语，且基础信息里没有这个标题作为文章标题的线索
  if (/invitation\s+to\s+dialogue|call\s+for\s+papers|proceedings\s+of|selected\s+papers|monographic/i.test(s)) return true;
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
  // v6.14：书目特征词直接判元数据（自然语句式污染没有"标签："结构，用特征词抓：
  // 内容摘要/关键词里出现 ISSN/ISBN/DOI/出版社/投稿日期等，几乎必然是版权页信息混入）
  if (/issn|isbn|\bdoi\b|10\.\d{4,}\//i.test(s)) return true;
  if (/投稿日期|接收日期|收稿日期|出版日期|版权页|出版社|出版时间|丛\s*书|主编|副主编/.test(s)) return true;
  if (/\b97[89]\d{10}\b/.test(s)) return true; // ISBN-13 裸数字
  // v6.15.1：自然语句式题录污染（无"标签："结构，但把期刊/卷/作者等题录信息当摘要/关键词填）
  // 典型如"本文献发表于Automation in Construction期刊，卷175，文章编号106170，2025年，作者为Pablo…"
  const hasJournal = /期刊|journal|学报|杂志/i.test(s);
  const hasVol = /卷\s*\d|第\s*\d+\s*卷|文章编号|article\s*(?:number|id)|vol\.?/i.test(s);
  const hasAuthorMeta = /作者[为是：:]|作者包括|作者分别|作者来自|author/i.test(s);
  const hasYear = /(19|20)\d{2}\s*年|\b(?:19|20)\d{2}\b/i.test(s);
  const hasAffil = /大学|学院|系|研究所|university|department|institute|laboratory|理工|天主教|瓦尔帕莱索|加泰罗尼亚|卡斯蒂利亚/i.test(s);
  // v6.16.2：关键词里出现期刊/卷期/DOI/投稿接收发表日期等题录信息 → 必定不是关键词
  const hasDateProcess = /投稿日期|接收日期|收稿日期|发表日期|出版时间|在线发表|投稿|接收|修订/i.test(s);
  const hasDOI = /\bdoi\b|doi:|10\.\d{4,}\//i.test(s);
  if (isKeywordField(fieldName)) {
    // 关键词出现机构/单位名（大学/学院/系等）→ 几乎必是题录误填
    if (hasAffil) return true;
    // 关键词出现期刊名/卷期/DOI/投稿接收发表日期/文章编号 → 必是题录误填
    if ((hasJournal && (hasVol || hasYear)) || hasDOI || hasDateProcess || /第\s*\d+\s*(?:期|卷)|\bvol\.?\s*\d+|no\.\s*\d+/i.test(s)) return true;
  }
  if (isAbstractField(fieldName)) {
    // 摘要堆题录：期刊+卷/文章编号，或 作者+单位/年份，或"本文为发表于…"
    if ((hasJournal && (hasVol || hasYear)) || (hasAuthorMeta && (hasAffil || hasYear))) return true;
    // "本文为发表于 X 期刊 Y 期" / "本文发表于 X 期刊" / "文章发表于" 等开头陈述 → 题录复述
    if (/^(本文|文章|本研究|该文|该研究)[是为]?\s*(?:发表|出版|刊载|刊于|载于|收录|来自)/i.test(s)) return true;
    // v6.16.5：摘要里出现书名号《期刊/书名》+ 年份 + 卷/期/文章编号/页码 → 题录复述
    if (/《[^》]+》\s*\d{4}年?\s*第?\s*\d+\s*[卷期](?:，|,)?\s*(?:文章编号|页码|pp\.)/.test(s)) return true;
    if (/《[^》]+》\s*\(\d{4}\)\s*[:：]?\s*\d{4,}/.test(s)) return true;
  }
  return false;
}

/** 摘要是否只是「基础信息」的复述（摘要与基础信息高度重合 → 题录污染，无效，触发重提）。
 *  用于跨字段校验：真实摘要应概括研究内容，而非把期刊/卷/作者/年份再抄一遍。 */
export function looksLikeBaseInfoDump(fieldName: string, v: string, baseInfo: string): boolean {
  if (!isAbstractField(fieldName) || !v || !baseInfo) return false;
  const a = normalizeText(v);
  const b = normalizeText(baseInfo);
  if (!a || !b) return false;
  // 摘要是基础的超串/子串（摘要只是基础信息加几个字，或反之）→ 复述
  if (a.includes(b) || b.includes(a)) return true;
  // 字符集合 Jaccard 相似度过高（摘要几乎全是题录字符）→ 复述
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter++;
  const union = setA.size + setB.size - inter;
  if (union > 0 && inter / union > 0.55) return true;
  return false;
}

/** 字段值是否为有效终值（可直接写入表格 / 视为"已提取"）。
 * 注意：「英文标题」的"无"是合法终值（确实没有英文标题），不能再当成空值反复重提。
 * 注意：「作者」字段返回"无"/"未提及" → 无效，文章必有作者，必须重提。 */
export function isFieldValueValid(
  fieldName: string,
  v: string | null | undefined,
  description = '',
  extra?: { baseInfo?: string; referencesText?: string }
): boolean {
  const s = v == null ? '' : (typeof v === 'string' ? v : String(v)).trim();
  if (!s) return false;
  // 作者字段："无" 不是合法值（论文/专著首页必有作者），空值/占位符也不行
  if (isAuthorField(fieldName) && (s === '无' || isEmptyValue(s) || isTemplateResidue(s))) return false;
  if (isEnglishTitleField(fieldName) && s === '无') return true;
  // 标题类字段返回了引文/出处串（AI 把引用格式当标题）→ 无效
  if (isTitleField(fieldName) && looksLikeCitation(s)) return false;
  // 标题类字段：与 baseInfo 里的"专题节点/特刊名"重合 → 不是论文本身的标题
  if (isTitleField(fieldName) && isSpecialIssueNodeTitle(s, extra?.baseInfo)) return false;
  if (isEmptyValue(s) || isTemplateResidue(s)) return false;
  // AI 的"搜索式编造/操作指引"垃圾（伪装搜索结果、承认虚构、教用户去 Google Scholar）
  if (looksLikeFabrication(s)) return false;
  // 相关文献必须是"多条目列表"结构 且 条目能在原文 References 里命中：单段散文 / 编造列表 → 无效
  if (isRelatedWorkField(fieldName) && !isRelatedWorkValuePlausible(s, extra?.referencesText)) return false;
  // 摘要/关键词被写成"作者：xxx；单位：xxx"式元数据罗列 → 无效，触发重提
  if (looksLikeMetadataDump(fieldName, s)) return false;
  // 摘要只是「基础信息」的复述（与基础信息高度重合）→ 无效，触发重提
  if (extra?.baseInfo && looksLikeBaseInfoDump(fieldName, s, extra.baseInfo)) return false;
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
    ? `\n- ${kwFields.map((f) => `「${f.name}」`).join('、')}：只填原文 Keywords（关键词）栏中列出的术语（通常紧跟摘要之后，多条用分号或顿号分隔）；外文关键词翻译成中文；文献自己提出的关键概念可适当补充，但严禁把以下内容当关键词：作者姓名、期刊名、发表年份、数据库名、文献篇数、投稿/出版日期、出版社、ISBN、主编/副主编姓名、丛书名、字数。若原文没有 Keywords 栏，填 "未提及"。`
    : '';
    // 摘要字段：概括研究内容本身，严禁元数据
  const absFields = fields.filter((f) => isAbstractField(f.name) && !looksLikeFabrication(f.name));
  const absRule = absFields.length
    ? `\n- ${absFields.map((f) => `「${f.name}」`).join('、')}：概括文献的研究内容本身（研究问题、方法、主要发现/结论），80-200 字；严禁把以下元数据写进摘要：作者名、期刊名、卷期年份、投稿/接收/出版日期、出版社、ISBN、数据库名、文献篇数、书名页/版权页信息；严禁写成"本书为《XXX》，由XXX著，XXX出版社出版，ISBN为XXX"这种版权页复述句。摘要内容必须能在【文献全文】中找到依据，不得与${fields.some((f) => f.name.includes('基础信息')) ? '「基础信息」' : '其他书目信息'}重复。`
    : '';
  // 相关文献字段：只允许原文 References 里真实存在的条目
  const rwFields = fields.filter((f) => isRelatedWorkField(f.name));
  const rwRule = rwFields.length
    ? `\n- ${rwFields.map((f) => `「${f.name}」`).join('、')}：从文末参考文献（References）列表中挑出最相关的 3-5 条，逐条列出"作者. 标题. 出处. 年份"，格式参考原文献的著录方式（如 GB/T 7714 或文中既有格式）；严禁编造原文参考文献列表中不存在的文献；严禁插入任何互联网搜索行为、操作指引（"打开 Google Scholar"等）或"无法访问互联网"之类的说明——你手上就是全文，文末就有真实参考文献。若确实没有"References"或"参考文献"栏（例如专著/教材的正文并未附带文献列表），只填 "未提及" 一个词；不要列出 Wikipedia、Google Scholar、博客或任何外部网址；不要编造"Public Art 101"、"From Concept to Commission"、"Americans for the Arts" 等通用书名或机构页作为文献。`
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
    const obj = JSON.parse(s);
    // 强制把所有值转成字符串：AI 偶尔把数字/布尔（如发表年份、字数）当作 JSON 原生类型返回，
    // 不转字符串会导致后续 v.trim() 在数值上抛 "X.trim is not a function"（记录3崩溃根因）
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(obj)) {
        if (k === '_error') { out[k] = String(val); continue; }
        const str = val == null
          ? ''
          : Array.isArray(val)
            ? val.join('；')
            : typeof val === 'string'
              ? val
              : String(val);
        out[k] = stripThinkTags(str);
      }
      return out;
    }
    return { _error: 'AI 未返回有效 JSON: ' + s.slice(0, 500) };
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
      ? `\n- 特别规则：字段名含"中文"（如中文题目/中文标题）时，必须把文献的外文标题翻译成通顺的简体中文填入；字段名不含"中文"的普通标题字段，外文文献也请翻译成通顺简体中文。标题通常在首页/封面最显眼处、字号最大的独立一行，紧挨作者名之前或之后。严禁把以下内容当标题：引文/出处串（et al./卷(年份)/DOI/ISSN）、期刊特刊/专题（节点）名称、报告编号、"No. 34 (July 2024)" 刊期号、版权页字符串。若确实找不到本文标题，只填 "无"。`
      : '';
    // 关键词/摘要/相关文献的精读专项规则
    const kwRule = isKeywordField(f.name)
      ? `\n- 特别规则：只填原文 Keywords（关键词）栏中的术语（外文关键词翻译成中文）；严禁把作者/期刊/年份/数据库名/特刊名当关键词；原文没有 Keywords 栏时只填 "未提及"。`
      : '';
    const absRule = isAbstractField(f.name)
      ? `\n- 特别规则：概括研究内容本身（问题/方法/发现），80-200 字；严禁写作者名、期刊/出版社、投稿出版日期、ISBN 等任何元数据。`
      : '';
    const rwRule = isRelatedWorkField(f.name)
      ? `\n- 特别规则：从文末 References 列表挑最相关的 3-5 条，逐条一行原样著录（作者. 标题. 出处. 年份，每条单独一行）；严禁编造文献、严禁任何搜索指引或拒答话术；无 References 栏时只填 "未提及"，不要列出 Wikipedia、Google Scholar、Web of Science、Scopus、CNKI、JSTOR 或任何外部网址凑数。`
      : '';
    // v6.14 首页锚定：标题/作者几乎总在全文最开头，把开头单独再喂一遍，防止模型在长文里"找不到"而填"无"
    // v6.16.2：作者字段首页锚定范围扩大到 2500 字（部分论文作者信息分散在前言/脚注）
    let anchorText = '';
    if ((isTitleField(f.name) || isAuthorField(f.name)) && text.length > 3000) {
      const anchorLen = isAuthorField(f.name) ? 2500 : 1500;
      anchorText = `\n\n【全文最开头 ${anchorLen} 字（标题和作者通常就在这里，请优先在这里定位）】\n${text.slice(0, anchorLen)}`;
    }
    user = `请从以下文献全文中，严格按下方要求提取唯一字段「${f.name}」的内容。\n\n【本字段的提取要求】\n${desc}\n\n提取规则：\n- 用简体中文填写（专有名词如作者/期刊/机构名保留原文）；\n- 必须先通读全文、定位与该字段相关的所有信息，再综合给出最准确、最完整的答案；\n- 内容要具体、有信息量，写出关键方法名、数据、对象、结论要点等细节，不要一句话空泛带过；\n- 若文中确实完全没有该字段相关信息，只填 "未提及" 一个词，严禁自己编造"未提供文献全文""文中未找到"等说明性文字；\n- 答案中严禁出现 [xxx]、「……」、「...」等占位符；\n- 直接输出该字段的值（一句话或一段，无需 JSON 包裹、无需重复字段名）。${etRule}${titleRule}${kwRule}${absRule}${rwRule}${anchorText}\n\n【文献全文】\n${text}`;
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
    const v = stripThinkTags(content.trim());
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
): Promise<ExtractResult & { usage: any }> {
  const CHUNK = mode === 'all' ? fields.length : mode === 'single' ? 1 : 5;
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

  // 并行执行批次（single 模式提到 8 并发，与 all 模式总耗时接近但准确率更高）
  const CONCURRENCY = mode === 'single' ? 8 : 4;
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
  // 提取 References 区块，用于后续相关文献字段的正向校验（防止 AI 编造文献）
  const referencesText = extractReferencesBlock(text);
  return { fields: merged, usage, raws, referencesText };
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
): Promise<ExtractResult> {
  const SEG = 140000;
  const OVERLAP = 1500;

  const referencesText = extractReferencesBlock(text);

  if (text.length <= SEG) {
    const r = await extractFields(text, fields, cfg, signal, mode);
    return { fields: r.fields, raws: r.raws, referencesText };
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
      // 强制转字符串：merged 里可能有非字符串（AI 把数字当 JSON 原生类型返回），
      // 直接 v.trim() 会在数值上抛 "X.trim is not a function"（记录3崩溃根因）
      const sv = v == null ? '' : (typeof v === 'string' ? v : String(v));
      if (!sv.trim() || isEmptyValue(sv) || isTemplateResidue(sv)) return true;
      return isDescriptionEcho(sv, f.description);
    });
    if (!missing.length) break;

    const r = await extractFields(segs[si], missing, cfg, signal, mode);
    Object.assign(merged, r.fields);
    raws.push(...r.raws.map((s) => `【第 ${si + 1}/${segs.length} 段】\n${s}`));
  }

  return { fields: merged, raws, referencesText };
}

/**
 * 写表前最终兜底清洗：某些 AI 返回值虽然躲过了 isFieldValueValid，但仍含明显垃圾特征，
 * 在写入表格前再暴力清一次，宁缺勿滥。
 * 返回清洗后的值；若判定为垃圾则返回空字符串。
 */
export function hardRejectGarbage(fieldName: string, v: string): string {
  const s = (v || '').trim();
  if (!s) return s;
  // 相关文献：任何含 http 链接 / 拒答话术 / 搜索指引 / "示例"说明 / Wikipedia 的一律清空
  if (isRelatedWorkField(fieldName)) {
    const lower = s.toLowerCase();
    if (/https?:\/\/|www\.|\.com|\.org|\.net|\.gov|\.edu|\.cn/.test(s)) return '';
    if (looksLikeFabrication(s) || isEmptyValue(s)) return '';
    if (/示例|仅供参考|不代表真实|你可以使用|你可以按照|建议你访问|建议您|访问以下|请.*搜索|打开.*scholar|搜索框中输入|根据您的要求.*搜索|通过.*搜索.*开源数据库/.test(s)) return '';
  }
  // 摘要/关键词：若仍混入版权页元数据（经 looksLikeMetadataDump 漏网）直接清空
  if (isAbstractField(fieldName) || isKeywordField(fieldName)) {
    // 含 ISBN-13 / 出版社 / 版权页 / 丛书 / 主编 / 投稿接收发表日期 / DOI / 书名 / 字数 等
    if (/\b97[89]\d{9,12}\b/.test(s)) return '';
    if (/版权页|出版社|出版时间|丛书|主编|副主编|字数|ISBN|DOI|版权所有|CIP/.test(s)) return '';
    if (/本书为《[^》]+》，由[^。]+著/.test(s)) return '';
    // 题录复述句：同时含 "书名"/"本文"/"发表"/"出版" + "作者"/"ISBN"/"出版社" 等三个以上元数据词
    const biblioMarkers = (s.match(/书名|本书|文献|发表于|刊载于|出版|作者|ISBN|出版社|DOI|卷|期|页码|字数|出版年/g) || []).length;
    if (biblioMarkers >= 3) return '';
  }
  return s;
}

/**
 * 专著（无 References 栏）的相关文献字段允许值：只允许 "未提及"/"无"/空；任何列表/链接/搜索指引都清空。
 */
export function sanitizeMonographRelatedWork(v: string, refBlock?: string): string {
  const s = (v || '').trim();
  if (!s) return s;
  if (s === '未提及' || s === '无') return s;
  // 有 References 区块 → 走普通校验，这里不清空
  if (refBlock && refBlock.length >= 20) return s;
  // 无 References 栏的专著：任何看起来像列表/书目/搜索推荐/外链的话都清空
  return '';
}

/**
 * 关键词字段清洗：按逗号/顿号/分号切分后逐条过滤，删除含 ISBN/出版社/作者/年份/字数/丛书等元数据的片段。
 * 只要还剩一条真正的概念词就保留；全部片段都是垃圾则返回空。
 */
export function sanitizeKeywordValue(v: string): string {
  const s = (v || '').trim();
  if (!s) return s;
  const seps = /[,，;；、]/;
  const items = s.split(seps).map((x) => x.trim()).filter(Boolean);
  if (!items.length) return s;
  const keep: string[] = [];
  for (const it of items) {
    const lower = it.toLowerCase();
    // 元数据过滤：ISBN、出版社、年份、字数、丛书、主编、作者名、DOI、出版流程词
    if (/\b97[89]\d{9,12}\b/.test(it)) continue;
    if (/出版社|出版年|出版时间|ISBN|DOI|版权页|丛书|主编|副主编|字数/.test(it)) continue;
    if (/^\d{4}\s*年?$|^\d{4}-\d{2}$/.test(it)) continue;
    // 人名过滤：关键词通常不会是完整作者署名（2-4 个中文常见姓名，或英文名+姓）——这里只过滤明显是"张三 著""Pablo Araya"类作者署名
    if (/[\u4e00-\u9fa5]{2,4}\s*(?:著|主编|副主编|译)$/.test(it)) continue;
    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+(-[A-Z][a-z]+)?$/.test(it)) continue;
    keep.push(it);
  }
  if (!keep.length) return '';
  return keep.join('；');
}
