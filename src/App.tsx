import './App.css';
import { bitable, FieldType, ITableMeta, IFieldMeta } from '@lark-base-open/js-sdk';
import {
  Button,
  Form,
  Input,
  Select,
  Banner,
  Spin,
  Toast,
  Checkbox,
  Collapsible,
} from '@douyinfe/semi-ui';
import { useState, useEffect, useRef, useCallback } from 'react';
import { parsePdf, assessTextQuality, TextQuality } from './lib/pdf';
import { extractFieldsAuto, PROVIDERS, ProviderId, TargetField, ExtractMode, ExtractResult, isDescriptionEcho, isFieldValueValid, isTitleField, isKeywordField, isAbstractField, isRelatedWorkField, isAuthorField, isBaseInfoField, looksLikeFabrication, normalizeSpecialFieldValue, titleNeedsRecheck, TITLE_GUARD_VER, modelLabel, stripThinkTags, hardRejectGarbage, sanitizeMonographRelatedWork, sanitizeKeywordValue, removeRepeatedSegment, isLikelyForeignTitle } from './lib/ai';

type RecState = {
  recordId: string;
  name: string;
  token?: string;
  status: 'pending' | 'downloading' | 'parsing' | 'generating' | 'done' | 'skipped' | 'error';
  message: string;
  skipped?: boolean;
  successCount?: number;
  failCount?: number;
  failedFields?: string[];
  // “仅补提空字段”模式下，本记录实际要提取的字段子集（预扫算好）
  onlyFields?: TargetField[];
};

const LS_KEY = 'literature_reader_cfg';
const CACHE_PREFIX = 'litcache:';
// 配置版本：v6.9（=2）起"仅补提空字段"默认改为不勾选，旧存储只恢复 API 配置、不再恢复旧勾选状态
const CFG_VER = 2;
// 面板版本号（显示在标题 + 写入每条记录的完成/失败消息，便于从导出截图追溯实际运行的代码版本）
const APP_VER = 'v6.18';
// 缓存结构版本：v6.14（=3）起缓存只存有效值；旧结构缓存（无 cacheVer 或版本更低）整体作废，
// 根除"历史污染值长年留在缓存里 → 写不进（被校验拦）也清不掉（被 hasNew 误判为有值）"的死锁。
const CACHE_VER = 9;

/** 把 js-sdk 字段描述（可能为 {content:[{text}]} 或字符串）提取为纯文本提示词 */
function descToText(d: any): string {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d?.content)) {
    return d.content.map((seg: any) => seg?.text ?? seg?.content ?? '').join('');
  }
  if (typeof d?.content === 'string') return d.content;
  return '';
}

/** 缓存键：记录 ID + 附件 token（token 随重新上传变化，避免误命中旧缓存） */
function cacheKey(recordId: string, token?: string): string {
  return CACHE_PREFIX + recordId + ':' + (token || '');
}
function getCache(key: string): { fields: Record<string, string>; guardVer: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    // v6.14：旧结构缓存（无 cacheVer 或版本低于当前）整体作废——历史缓存里可能存着
    // 拒答话术/元数据罗列等污染值，作废重提比带着污染值跑十轮都可靠
    if (typeof obj?.cacheVer !== 'number' || obj.cacheVer < CACHE_VER) return null;
    if (obj?.fields && typeof obj.fields === 'object') {
      // guardVer：标题防呆版本。旧缓存（v6.10 之前写入）没有该字段 → 视为 0（标题"无"未经过防呆确认）
      return { fields: obj.fields, guardVer: typeof obj.guardVer === 'number' ? obj.guardVer : 0 };
    }
    return null;
  } catch {
    return null;
  }
}
function setCache(key: string, fields: Record<string, string>) {
  try {
    // v6.14：只缓存有效值——拒答话术/元数据罗列/占位符/引文串不进缓存，
    // 否则它们会让清理循环的 hasNew 误判"本次有值"而跳过擦表（污染死锁的根源）
    // v6.16.2：缓存校验也传入 extra（baseInfo + referencesText），避免相关文献/摘要因缺上下文而通过
    const clean: Record<string, string> = {};
    const baseInfo = fields['基础信息'] || fields['文章信息'] || '';
    const referencesText = fields['相关文献'] || fields['参考文献'] || ''; // 缓存阶段可用已提的相关文献文本近似（或空）
    for (const [k, raw] of Object.entries(fields || {})) {
      const s = normalizeSpecialFieldValue(k, String(raw ?? '')).trim();
      if (s && isFieldValueValid(k, s, undefined, { baseInfo, referencesText })) clean[k] = s;
    }
    localStorage.setItem(key, JSON.stringify({ fields: clean, guardVer: TITLE_GUARD_VER, cacheVer: CACHE_VER, ts: Date.now() }));
  } catch { /* 配额超限忽略 */ }
}

/** 把提取结果逐字段写回表格（保护：单字段失败不影响其他）。只遍历实际提取的 effectiveFields。 */
async function writeFields(
  table: any,
  job: RecState,
  fields: Record<string, string>,
  effectiveFields: TargetField[],
  onlyEmpty: boolean,
  titlesTrusted: boolean,
  referencesText?: string,
  foreignSnippets?: string[]
): Promise<{ successCount: number; failCount: number; emptyCount: number; echoCount: number; existingCount: number; failedFields: string[]; clearedCount: number }> {
  let successCount = 0, failCount = 0, emptyCount = 0, echoCount = 0, existingCount = 0, clearedCount = 0;
  const failedFields: string[] = [];
  for (const tf of effectiveFields) {
    try {
      const key = Object.keys(fields).find((k) => k.trim().toLowerCase() === tf.name.trim().toLowerCase());
      let v = key ? fields[key] : undefined;
      if (v == null) { emptyCount += 1; continue; }
      v = typeof v === 'string' ? v : String(v);
      // 兜底剥离模型推理标签（部分模型在字段值里夹带 <think>…</think>，AI 层已剥过一次，这里再保一道）
      v = stripThinkTags(v);
      // v6.18：写表前去重复片段（如"标题 标题"）
      v = removeRepeatedSegment(v);
      // 特殊字段归一化（如英文标题：没有英文字母 → 统一写"无"）
      v = normalizeSpecialFieldValue(tf.name, v);
      if (!v.trim()) { emptyCount += 1; continue; }
      if (isDescriptionEcho(v, tf.description)) { echoCount += 1; continue; }
      // "无"（英文标题）等合法终值直接写入；真正无效的值（未提及/拒答/模板残留）不写入
      // v6.15.1：传入「基础信息」做跨字段校验；v6.16：传入原文 References 做相关文献正向校验
      const extra = { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: referencesText || '' };
      if (!isFieldValueValid(tf.name, v, undefined, extra)) { emptyCount += 1; continue; }
      // v6.16.3：写表前最终兜底清洗，宁缺勿滥
      v = hardRejectGarbage(tf.name, v);
      // v6.16.6：关键词按分隔符切分后逐条过滤元数据片段
      if (isKeywordField(tf.name)) v = sanitizeKeywordValue(v);
      if (isRelatedWorkField(tf.name)) v = sanitizeMonographRelatedWork(v, referencesText);
      // v6.18：命中其他记录标题片段 → 串味垃圾清空（基础信息字段除外）
      if (v && !isBaseInfoField(tf.name) && isLikelyForeignTitle(v, foreignSnippets || [])) v = '';
      if (!v.trim()) { emptyCount += 1; continue; }
      if (onlyEmpty) {
        const cur = (await table.getRecordById(job.recordId)).fields[tf.fieldId];
        const curStr = (Array.isArray(cur) ? cur.map((s: any) => s?.text ?? s ?? '').join('') : String(cur ?? '')).trim();
      // 已有"有效且可信"的内容才跳过：表格里未经防呆确认的标题"无"/引文串不算 → 允许用重提的正确标题覆盖
      const curExtra = { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: referencesText || '' };
      const curValid = isFieldValueValid(tf.name, curStr, tf.description, curExtra) && !(titleNeedsRecheck(tf.name, curStr) && !titlesTrusted);
      if (curValid) { existingCount += 1; continue; }
      }
      await table.setCellValue(tf.fieldId, job.recordId, v.trim());
      successCount += 1;
    } catch (e: any) {
      failCount += 1;
      failedFields.push(tf.name);
    }
  }
  // v6.13 洗刷残留：本次提取判定为无效的字段（值缺失/被防呆删除），如果表格里还留着
  // 旧一轮（旧版插件）写入的垃圾值（拒答话术/编造链接/元数据罗列/引文串），清空它。
  // 否则会出现"新逻辑删了值，但表格里旧垃圾没人擦"——导出 Excel 时旧垃圾原样带出。
  for (const tf of effectiveFields) {
    try {
      const key = Object.keys(fields).find((k) => k.trim().toLowerCase() === tf.name.trim().toLowerCase());
      // v6.14：hasNew 必须是"有【有效】值"——缓存里存的拒答话术/元数据罗列虽非空，
      // 但会被写入校验拦下永远进不了表格；若把它们当"有值"跳过清理，旧垃圾就永远留在单元格里
      let hasNew = false;
      if (key != null && fields[key] != null) {
        const nv = normalizeSpecialFieldValue(tf.name, String(fields[key])).trim();
        hasNew = nv !== '' && isFieldValueValid(tf.name, nv, undefined, { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: referencesText || '' });
      }
      if (hasNew) continue; // 本次有有效值已正常写入，无需清理
      const rec = await table.getRecordById(job.recordId);
      const cur = rec.fields[tf.fieldId];
      const curStr = (Array.isArray(cur) ? cur.map((s: any) => s?.text ?? s ?? '').join('') : String(cur ?? '')).trim();
      if (!curStr) continue;
      const cleanExtra = { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: referencesText || '' };
      let curLooksGarbage = !isFieldValueValid(tf.name, curStr, tf.description, cleanExtra)
        || (titleNeedsRecheck(tf.name, curStr) && !titlesTrusted)
        || !hardRejectGarbage(tf.name, curStr)
        || (isRelatedWorkField(tf.name) && !sanitizeMonographRelatedWork(curStr, referencesText));
      // v6.18：当前值非空且命中其他记录的标题片段 → 视为串味垃圾清空（基础信息字段除外）
      if (!curLooksGarbage && curStr && !isBaseInfoField(tf.name) && isLikelyForeignTitle(curStr, foreignSnippets || [])) {
        curLooksGarbage = true;
      }
      if (!curLooksGarbage) continue; // 旧值合法（如英文标题的"无"、用户手工填的正确值）→ 不动
      await table.setCellValue(tf.fieldId, job.recordId, '');
      clearedCount += 1;
    } catch { /* 清理失败不影响主流程 */ }
  }
  // v6.16.6：同义字段回填——若面板里有"中文题目"字段但值为空，"中文标题"有有效值，则把中文标题复制给中文题目
  const titleCnField = effectiveFields.find((f) => f.name.trim() === '中文题目');
  const titleCnAltField = effectiveFields.find((f) => f.name.trim() === '中文标题');
  if (titleCnField && titleCnAltField) {
    try {
      const rec = await table.getRecordById(job.recordId);
      const cur = rec.fields[titleCnField.fieldId];
      const curStr = (Array.isArray(cur) ? cur.map((s: any) => s?.text ?? s ?? '').join('') : String(cur ?? '')).trim();
      if (!curStr) {
        const altKey = Object.keys(fields).find((k) => k.trim().toLowerCase() === titleCnAltField.name.trim().toLowerCase());
        const altV = altKey ? fields[altKey] : undefined;
        const altS = altV == null ? '' : String(altV).trim();
        if (altS && isFieldValueValid(titleCnAltField.name, altS, titleCnAltField.description, { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: referencesText || '' })) {
          await table.setCellValue(titleCnField.fieldId, job.recordId, altS);
          successCount += 1;
        }
      }
    } catch { /* 回填失败不影响主流程 */ }
  }
  // v6.16.6：同义字段回填——"研究目的"为空时回填"研究目标"的有效值
  const goalField = effectiveFields.find((f) => f.name.trim() === '研究目的');
  const goalAltField = effectiveFields.find((f) => f.name.trim() === '研究目标');
  if (goalField && goalAltField) {
    try {
      const rec = await table.getRecordById(job.recordId);
      const cur = rec.fields[goalField.fieldId];
      const curStr = (Array.isArray(cur) ? cur.map((s: any) => s?.text ?? s ?? '').join('') : String(cur ?? '')).trim();
      if (!curStr) {
        const altKey = Object.keys(fields).find((k) => k.trim().toLowerCase() === goalAltField.name.trim().toLowerCase());
        const altV = altKey ? fields[altKey] : undefined;
        const altS = altV == null ? '' : String(altV).trim();
        if (altS && isFieldValueValid(goalAltField.name, altS, goalAltField.description, { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: referencesText || '' })) {
          await table.setCellValue(goalField.fieldId, job.recordId, altS);
          successCount += 1;
        }
      }
    } catch { /* 回填失败不影响主流程 */ }
  }
  return { successCount, failCount, emptyCount, echoCount, existingCount, failedFields, clearedCount };
}

export default function App() {
  const [tableMetaList, setTableMetaList] = useState<ITableMeta[]>([]);
  const [tableId, setTableId] = useState<string>();
  const [attachFieldId, setAttachFieldId] = useState<string>();
  const [attachFields, setAttachFields] = useState<{ label: string; value: string }[]>([]);
  const [targetFields, setTargetFields] = useState<TargetField[]>([]);
  const [provider, setProvider] = useState<ProviderId>('siliconflow');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(PROVIDERS.siliconflow.models[0]);
  // 解析字符数统计（调试用）
  const [parsedChars, setParsedChars] = useState<number | null>(null);
  // 最近一次解析的文本质量诊断 + 样本（调试用）
  const [textQuality, setTextQuality] = useState<TextQuality | null>(null);
  // 最近一次 AI 对每个字段的返回值详情（调试用）
  const [aiReturnPreview, setAiReturnPreview] = useState<string>('');
  // 提取模式：all=全部一次（实测最快但字段多易稀释注意力）/ chunk=每批5个 / single=单字段逐个（最准）
  // v6.16.4 默认 single：字段数≥25 时 all 模式 AI 会顾此失彼，导致标题/摘要/相关文献大面积出错；single 并发 8 总耗时与 all 接近但准确率最高
  const [extractMode, setExtractMode] = useState<ExtractMode>('single');
  // 解析字数上限：越小单次 AI 调用越快、越省额度；0=智能分段（不限字数，自动切段补漏）
  const [parseLimit, setParseLimit] = useState<number>(150000);
  // 仅补提空字段：默认不勾选（正常提取应为全量提取；需要增量补漏时用户自己勾选）
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  // 已提取判定阈值：有内容的目标字段数 ≥ 阈值即视为"已提取过"，批量时整行跳过；0 = 不跳过
  // v6.14 默认改 0：阈值 1 会让"重跑修复"静默跳过已有内容的行（旧垃圾原样留在表里），用户以为跑了其实没跑
  const [skipThreshold, setSkipThreshold] = useState<number>(0);
  // 强制重新提取：忽略本地缓存（用于覆盖错误结果）
  const [forceRefresh, setForceRefresh] = useState(false);
  // 后台预提取进行中（只缓存不写字段）
  const [prerunning, setPrerunning] = useState(false);
  const [running, setRunning] = useState(false);
  const [recs, setRecs] = useState<RecState[]>([]);
  const abortRef = useRef<AbortController | null>(null);


  // 初始化：加载表列表与保存的配置
  useEffect(() => {
    Promise.all([bitable.base.getTableMetaList(), bitable.base.getSelection()])
      .then(([metaList, sel]) => {
        setTableMetaList(metaList);
        const tid = sel?.tableId || metaList[0]?.id;
        setTableId(tid);
        loadTableConfig(tid);
      })
      .catch((e) => Toast.error({ content: `初始化失败：${String(e)}` }));
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (saved.provider && PROVIDERS[saved.provider as ProviderId]) {
        setProvider(saved.provider as ProviderId);
      }
      if (saved.apiKey) setApiKey(saved.apiKey);
      if (saved.model) {
        // 如果保存的模型当前 provider 没有，则 fallback 到该 provider 第一个
        const list = PROVIDERS[saved.provider as ProviderId || provider].models;
        setModel(list.includes(saved.model) ? saved.model : list[0]);
      }
      // 旧版本配置（_cfgVer !== CFG_VER）不恢复 onlyEmpty，让它回到默认"不勾选"
      if (saved._cfgVer === CFG_VER && typeof saved.onlyEmpty === 'boolean') setOnlyEmpty(saved.onlyEmpty);
    } catch { /* ignore */ }
  }, []);

  /** 读取某张表：附件字段列表 + 所有文本字段（作为提取目标，字段名+描述即提示词） */
  const loadTableConfig = useCallback(async (tid?: string) => {
    if (!tid) return;
    try {
      const table = await bitable.base.getTableById(tid);
      const metas: IFieldMeta[] = await table.getFieldMetaList();
      const atts = metas
        .filter((m) => m.type === FieldType.Attachment)
        .map((m) => ({ label: m.name, value: m.id }));
      setAttachFields(atts);
      if (atts.length && !atts.find((a) => a.value === attachFieldId)) {
        setAttachFieldId(atts[0].value);
      }
      // 目标字段 = 所有“文本”类型字段（字段描述即用户的提示词）
      const targets: TargetField[] = metas
        .filter((m) => m.type === FieldType.Text && m.id !== attachFieldId)
        .map((m) => ({
          name: m.name,
          fieldId: m.id,
          description: descToText((m as any).description).trim(),
        }))
        .filter((f) => f.name);
      setTargetFields(targets);
    } catch { /* ignore */ }
  }, [attachFieldId]);

  const onTableChange = (tid: string) => {
    setTableId(tid);
    setAttachFieldId(undefined);
    setTargetFields([]);
    loadTableConfig(tid);
  };

  const saveCfg = (p: ProviderId, k: string, m: string, oe: boolean) => {
    localStorage.setItem(LS_KEY, JSON.stringify({ provider: p, apiKey: k, model: m, onlyEmpty: oe, _cfgVer: CFG_VER }));
  };

  // 单条记录处理：缓存命中则秒出；否则 下载→解析→AI提取→（可选）写回→缓存
  const processJob = useCallback(async (
    job: RecState,
    table: any,
    ac: AbortController,
    opts: {
      write: boolean; useCache: boolean; forceRefresh: boolean;
      effectiveFields: TargetField[]; extractMode: ExtractMode; parseLimit: number;
      onlyEmpty: boolean; onlyFields?: TargetField[]; provider: ProviderId; apiKey: string; model: string;
      _retried?: boolean; // v6.14：网络错误自动重试标记（防无限重试）
      foreignSnippets?: string[]; // v6.18：跨记录标题片段，用于识别串味垃圾
    }
  ) => {
    const setState = (patch: Partial<RecState>) =>
      setRecs((prev) => prev.map((r) => (r.recordId === job.recordId ? { ...r, ...patch } : r)));
    const key = cacheKey(job.recordId, job.token);
    // 1) 缓存命中 → 完整命中秒出；部分命中（如旧版快速模式只缓存了核心字段）→ 只补提缺失字段
    let partialCached: Record<string, string> | null = null;
    let partialMissing: TargetField[] | null = null;
    if (opts.useCache && !opts.forceRefresh) {
      const entry = getCache(key);
      const cached: Record<string, string> = entry?.fields ?? {};
      // 标题防呆：旧版缓存（guardVer 低于当前）里的标题"无"/引文串可能是 AI 敷衍写入的，未经过精读确认 → 视为缺失，复核一次
      const titlesTrusted = !!entry && entry.guardVer >= TITLE_GUARD_VER;
      const missing = opts.effectiveFields.filter((f) => {
        const k = Object.keys(cached).find((ck) => ck.trim().toLowerCase() === f.name.trim().toLowerCase());
        const v = k ? cached[k] : undefined;
        if (!isFieldValueValid(f.name, v, f.description, { baseInfo: cached['基础信息'] || cached['文章信息'] || '', referencesText: '' })) return true;
        if (!titlesTrusted && titleNeedsRecheck(f.name, v)) return true;
        return false;
      });
      // 完整命中：所有字段都有效且可信 → 秒出
      if (missing.length === 0) {
        if (opts.write) {
          const w = await writeFields(table, job, cached, opts.effectiveFields, opts.onlyEmpty, titlesTrusted, '', opts.foreignSnippets);
          const parts = [`写入 ${w.successCount}/${opts.effectiveFields.length}`];
          if (w.emptyCount) parts.push(`AI未给 ${w.emptyCount}`);
          if (w.existingCount) parts.push(`已有跳过 ${w.existingCount}`);
          if (w.failCount) parts.push(`失败 ${w.failCount}`);
          setState({ status: 'done', message: `缓存秒出 · ${parts.join('，')}`, successCount: w.successCount, failCount: w.failCount });
        } else {
          setState({ status: 'done', message: '已缓存（点“开始批量提取”即可秒出）', successCount: opts.effectiveFields.length });
        }
        return;
      }
      // 部分命中：记住旧缓存，稍后只补提缺失字段
      partialCached = cached;
      partialMissing = missing;
    }
    // 2) 全量流水线
    try {
      setState({ status: 'downloading', message: '下载附件' });
      const urls = await table.getCellAttachmentUrls([job.token as string], attachFieldId, job.recordId);
      if (!urls?.length) throw new Error('获取附件链接失败');
      const blob = await (await fetch(urls[0])).blob();
      setState({ status: 'parsing', message: '解析 PDF' });
      const buf = await blob.arrayBuffer();
      const { text, pages, truncated } = await parsePdf(buf, { maxChars: opts.parseLimit || 100000000 });
      if (text.trim().length < 50) throw new Error('PDF 几乎无文本层（可能是纯扫描件），暂不支持');
      setParsedChars(text.length);
      const quality = assessTextQuality(text);
      setTextQuality(quality);
      if (!quality.ok) {
        setState({ status: 'error', message: `PDF 解析文本质量异常，已停止。${quality.reason}` });
        return;
      }
      // 本次实际要提取的字段 =（缓存缺失 ∪ 全量）∩（仅补提模式的空字段子集）
      let extractList = partialMissing ?? opts.effectiveFields;
      if (opts.onlyFields?.length) {
        const allow = new Set(opts.onlyFields.map((f) => f.fieldId));
        extractList = extractList.filter((f) => allow.has(f.fieldId));
      }
      if (!extractList.length) {
        // 缓存与表格已有内容已覆盖本次要提的字段 → 直接写回收尾
        if (opts.write) {
          const preEntry = getCache(key);
          const w = await writeFields(table, job, partialCached ?? {}, opts.effectiveFields, opts.onlyEmpty, !!preEntry && preEntry.guardVer >= TITLE_GUARD_VER, '', opts.foreignSnippets);
          setState({ status: 'done', message: `无缺失字段，写入 ${w.successCount}/${opts.effectiveFields.length}`, successCount: w.successCount });
        } else {
          setState({ status: 'done', message: '无缺失字段', successCount: 0 });
        }
        return;
      }
      setState({ status: 'generating', message: `${partialCached ? `缓存补提缺失 ${extractList.length} 字段 · ` : `本次提取 ${extractList.length} 字段 · `}AI 生成中（${pages} 页 / ${text.length.toLocaleString()} 字符${truncated ? '，已截断' : ''}）` });
      const startedAt = Date.now();
      let segInfo = '';
      const timer = setInterval(() => {
        const sec = Math.round((Date.now() - startedAt) / 1000);
        setState({ status: 'generating', message: `AI 生成中${segInfo ? `（${segInfo}）` : ''} · 已 ${sec} 秒` });
      }, 3000);
      let extractResult: ExtractResult;
      try {
        extractResult = await extractFieldsAuto(text, extractList, { provider: opts.provider, apiKey: opts.apiKey, model: opts.model }, ac.signal, opts.extractMode, (i, n) => { segInfo = `第 ${i}/${n} 段`; });
      } finally { clearInterval(timer); }
      const fields = extractResult.fields;
      const referencesText = extractResult.referencesText;
      let raws = extractResult.raws;
      // 特殊字段归一化：英文标题没有英文字母（纯中文/中文书名）→ 统一写"无"
      for (const tf of extractList) {
        const k = Object.keys(fields).find((ok) => ok.trim().toLowerCase() === tf.name.trim().toLowerCase());
        if (k) fields[k] = normalizeSpecialFieldValue(tf.name, typeof fields[k] === 'string' ? fields[k] : String(fields[k] ?? ''));
      }
      // 精读重试：AI 返回无效值（未提及/拒答/占位符/引文串/编造话术）的字段，改用精读模式（单字段+全文+该字段自己的提示词）再试一次。
      // 标题/关键词/摘要/相关文献是高误报字段——批量模式下 AI 容易拿元数据凑数，故这四类字段即使返回了"看似有效"的值也要复核一次（信任精读结果）。
      const needsRetry = (f: TargetField): boolean => {
        const k = Object.keys(fields).find((ok) => ok.trim().toLowerCase() === f.name.trim().toLowerCase());
        const v = k ? fields[k] : undefined;
        const s = v == null ? '' : String(v).trim();
        if (!isFieldValueValid(f.name, v, f.description, { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: referencesText || '' })) return true;
        if (isTitleField(f.name) && s === '无') return true;
        // 高误报字段：批量结果有值也要精读复核（精读带全文+专项规则，可信度更高）
        return isTitleField(f.name) || isKeywordField(f.name) || isAbstractField(f.name) || isRelatedWorkField(f.name);
      };
      // 排序：无效值字段（必须重试出结果）优先，有值的高风险复核字段排后，防止 slice 截断把无效字段挤掉
      const retryAll = extractList.filter((f) => needsRetry(f));
      const retryInvalid = retryAll.filter((f) => {
        const k = Object.keys(fields).find((ok) => ok.trim().toLowerCase() === f.name.trim().toLowerCase());
        return !isFieldValueValid(f.name, k ? fields[k] : undefined, f.description, { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: referencesText || '' });
      });
      const retryRecheck = retryAll.filter((f) => !retryInvalid.includes(f));
      const retryFields = [...retryInvalid, ...retryRecheck].slice(0, 12);
      if (retryFields.length) {
        const invalidMsg = retryInvalid.length ? `${retryInvalid.length} 个无效` : '';
        const recheckMsg = retryRecheck.length ? `${retryRecheck.length} 个待复核` : '';
        setState({ status: 'generating', message: `精读重试中（${[invalidMsg, recheckMsg].filter(Boolean).join(' + ')}：${retryFields.map((f) => f.name).join('、')}），耗时与字段数成正比…` });
        try {
          const r2 = await extractFieldsAuto(text, retryFields, { provider: opts.provider, apiKey: opts.apiKey, model: opts.model }, ac.signal, 'single');
          const retryReferencesText = r2.referencesText || referencesText || '';
          raws = [...raws, ...r2.raws];
          for (const [k, vRaw] of Object.entries(r2.fields)) {
            const rf = retryFields.find((f) => f.name.trim().toLowerCase() === k.trim().toLowerCase());
            if (!rf) continue;
            const s = normalizeSpecialFieldValue(rf.name, (typeof vRaw === 'string' ? vRaw : String(vRaw)).trim());
            const origKey = Object.keys(fields).find((ok) => ok.trim().toLowerCase() === k.trim().toLowerCase());
            if (isFieldValueValid(rf.name, s, rf.description, { baseInfo: fields['基础信息'] || fields['文章信息'] || '', referencesText: retryReferencesText || '' })) {
              // 精读结果有效 → 覆盖批量结果
              if (origKey) fields[origKey] = s; else fields[k] = s;
            } else if (retryInvalid.includes(rf)) {
              // 无效字段精读仍无效 → 清掉批量阶段的垃圾值（拒答/编造/占位符），宁缺勿滥
              if (origKey) delete fields[origKey]; else delete fields[k];
            }
            // 高风险复核字段精读也无效 → 保留批量原值（批量结果可能仍是对的）
          }
        } catch { /* 重试失败不影响主结果 */ }
      }
      // 与旧缓存合并（新结果优先），缓存始终保存"目前已知最全"的字段集
      const mergedFields: Record<string, string> = { ...(partialCached ?? {}), ...fields };
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`;
      setAiReturnPreview(
        (raws.length ? `===== AI 原始返回 =====\n${raws.join('\n\n')}\n\n` : '') +
        '===== 解析后的字段值 =====\n' +
        Object.entries(fields).map(([k, v]) => `${k} = ${(typeof v === 'string' ? v : String(v)).slice(0, 30)}${(typeof v === 'string' ? v : String(v)).length > 30 ? '…' : ''}`).join('\n')
      );
      // 写入信任度必须在 setCache 之前计算：本次刚提取的标题已经过防呆重试确认 → 信任本次提取前的旧缓存状态
      const preWriteEntry = getCache(key);
      const titlesTrustedForWrite = !!preWriteEntry && preWriteEntry.guardVer >= TITLE_GUARD_VER;
      setCache(key, mergedFields);
      if (opts.write) {
        const w = await writeFields(table, job, mergedFields, opts.effectiveFields, opts.onlyEmpty, titlesTrustedForWrite, referencesText || '', opts.foreignSnippets);
        const parts = [`${partialCached ? '缓存补提后写入' : '写入'} ${w.successCount}/${opts.effectiveFields.length}`];
        if (w.emptyCount) parts.push(`AI未给 ${w.emptyCount}`);
        if (w.echoCount) parts.push(`过滤回声 ${w.echoCount}`);
        if (w.existingCount) parts.push(`已有跳过 ${w.existingCount}`);
        if (w.failCount) parts.push(`失败 ${w.failCount}：${w.failedFields.join('、')}`);
        setState({ status: 'done', message: `[${APP_VER}] ${parts.join('，')}，耗时 ${elapsedStr}`, successCount: w.successCount, failCount: w.failCount });
      } else {
        setState({ status: 'done', message: `已缓存 · 共 ${Object.keys(mergedFields).length} 字段（本次新提 ${Object.keys(fields).length}），耗时 ${elapsedStr}`, successCount: Object.keys(mergedFields).length });
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') { setState({ status: 'error', message: '已停止' }); return; }
      const errMsg = String(e?.message || e);
      // v6.14：网络层瞬时错误（Failed to fetch 等，附件下载和 AI 调用都可能撞上）自动重试 1 次，
      // 避免整条记录因一次网络波动全军覆没（实测案例：记录整行 0 字段 + "Failed to fetch"）
      if (!opts._retried && /failed to fetch|networkerror|load failed|timed?\s*out|network/i.test(errMsg)) {
        setState({ status: 'pending', message: '网络波动，5 秒后自动重试本条记录…' });
        setTimeout(() => { processJob(job, table, ac, { ...opts, _retried: true }); }, 5000);
        return;
      }
      setState({ status: 'error', message: `[${APP_VER}] ${errMsg.slice(0, 480)}`, failCount: opts.effectiveFields.length, failedFields: opts.effectiveFields.map((f) => f.name) });
    }
  }, [attachFieldId]);

  const run = useCallback(async () => {
    if (!tableId || !attachFieldId) { Toast.warning({ content: '请先选择数据表和附件字段' }); return; }
    if (!apiKey) { Toast.warning({ content: `请填写 ${PROVIDERS[provider].label} API Key` }); return; }
    const effectiveFields = targetFields;
    if (!effectiveFields.length) { Toast.warning({ content: '当前表没有可提取的文本字段（请先建好带提示词的文本字段）' }); return; }
    // 强制重新提取 = 忽略缓存 + 覆盖已有内容（否则“仅填充空字段”会拦住写入，让人误以为没重新提取）
    const effOnlyEmpty = onlyEmpty && !forceRefresh;
    saveCfg(provider, apiKey, model, onlyEmpty);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const table = await bitable.base.getTableById(tableId);
      const recordIds = await table.getRecordIdList();
      // v6.18：预扫前收集跨记录标题片段，用于识别串味垃圾
      const foreignSnippets: string[] = [];
      for (const rid of recordIds) {
        const rec = await table.getRecordById(rid);
        const baseInfo = String(((rec.fields as any)['基础信息'] || (rec.fields as any)['文章信息']) ?? '').trim();
        if (baseInfo) foreignSnippets.push(baseInfo.slice(0, 60));
        for (const tf of effectiveFields) {
          if (!isTitleField(tf.name)) continue;
          const v = (rec.fields as any)[tf.fieldId];
          const s = (Array.isArray(v) ? v.map((x: any) => x?.text ?? x ?? '').join('') : String(v ?? '')).trim();
          if (s && s !== '无') foreignSnippets.push(s);
        }
      }
      // 预扫：
      // - 勾选“仅补提空字段”→ 逐记录找出空/无效字段，只提取这些（不再整行跳过）
      // - 未勾选（全量重提）→ 旧的整行跳过逻辑（skipThreshold）
      const prescan = await Promise.all(recordIds.map(async (rid) => {
        const rec = await table.getRecordById(rid);
        const atts = (rec.fields as any)[attachFieldId] as any[] | undefined;
        if (!atts?.[0]?.token) return { filled: 0, extracted: false, emptyFields: [] as TargetField[] };
        // 标题防呆：该记录缓存缺失/旧版（guardVer 低）时，表格里标题的"无"/引文串未经过防呆确认 → 不算有效，需要复核
        const entry = getCache(cacheKey(rid, atts[0].token));
        const titlesTrusted = !!entry && entry.guardVer >= TITLE_GUARD_VER;
        const valid = (tf: TargetField, curStr: string): boolean => {
          // v6.16.2：预扫也传入 baseInfo（取当前记录的"基础信息"/"文章信息"），确保"摘要"与基础信息重复的题录污染被识别为空字段
          const curBaseInfo = String(((rec.fields as any)['基础信息'] || (rec.fields as any)['文章信息']) ?? '');
          if (!isFieldValueValid(tf.name, curStr, tf.description, { baseInfo: curBaseInfo, referencesText: '' })) return false;
          if (!titlesTrusted && titleNeedsRecheck(tf.name, curStr)) return false;
          return true;
        };
        const cellStr = (v: any): string => (Array.isArray(v) ? v.map((s: any) => s?.text ?? s ?? '').join('') : String(v ?? '')).trim();
        if (effOnlyEmpty) {
          // 注意："无"（英文标题类字段）经防呆确认后是合法终值，不算空字段，避免纯中文文献被反复重提
          const emptyFields = effectiveFields.filter((tf) => !valid(tf, cellStr((rec.fields as any)[tf.fieldId])));
          return { filled: effectiveFields.length - emptyFields.length, extracted: emptyFields.length === 0, emptyFields };
        }
        if (skipThreshold === 0) return { filled: 0, extracted: false, emptyFields: [] as TargetField[] };
        let filled = 0;
        for (const tf of effectiveFields) {
          if (valid(tf, cellStr((rec.fields as any)[tf.fieldId]))) filled += 1;
        }
        return { filled, extracted: filled >= skipThreshold, emptyFields: [] as TargetField[] };
      }));
      const jobs: RecState[] = [];
      for (let i = 0; i < recordIds.length; i++) {
        const rec = await table.getRecordById(recordIds[i]);
        const first = (rec.fields as any)[attachFieldId]?.[0];
        if (!first?.token) continue;
        if (prescan[i].extracted) {
          jobs.push({ recordId: recordIds[i], name: first.name || '未命名附件', status: 'skipped', message: effOnlyEmpty ? `全部 ${effectiveFields.length} 个字段已有有效内容，跳过` : `已提取过（${prescan[i].filled}/${effectiveFields.length} 个字段已有内容），跳过`, skipped: true });
        } else {
          jobs.push({ recordId: recordIds[i], name: first.name || '未命名附件', token: first.token, status: 'pending', message: '', onlyFields: effOnlyEmpty ? prescan[i].emptyFields : undefined });
        }
      }
      setRecs(jobs);
      if (!jobs.length) { Toast.warning({ content: '未找到带附件的记录' }); setRunning(false); return; }
      for (const job of jobs) {
        if (ac.signal.aborted) break;
        if (job.skipped) continue;
        await processJob(job, table, ac, { write: true, useCache: true, forceRefresh, effectiveFields, extractMode, parseLimit, onlyEmpty: effOnlyEmpty, onlyFields: job.onlyFields, provider, apiKey, model, foreignSnippets });
      }
    } catch (e: any) {
      Toast.error({ content: `执行出错：${String(e?.message || e)}` });
    } finally {
      setRunning(false);
    }
  }, [tableId, attachFieldId, apiKey, model, onlyEmpty, targetFields, extractMode, parseLimit, skipThreshold, forceRefresh, processJob]);

  const runPreExtract = useCallback(async () => {
    if (!tableId || !attachFieldId) { Toast.warning({ content: '请先选择数据表和附件字段' }); return; }
    if (!apiKey) { Toast.warning({ content: `请填写 ${PROVIDERS[provider].label} API Key` }); return; }
    const effectiveFields = targetFields;
    if (!effectiveFields.length) { Toast.warning({ content: '当前表没有可提取的文本字段' }); return; }
    saveCfg(provider, apiKey, model, onlyEmpty);
    setPrerunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const table = await bitable.base.getTableById(tableId);
      const recordIds = await table.getRecordIdList();
      const jobs: RecState[] = [];
      for (const rid of recordIds) {
        const rec = await table.getRecordById(rid);
        const first = (rec.fields as any)[attachFieldId]?.[0];
        if (first?.token) jobs.push({ recordId: rid, name: first.name || '未命名附件', token: first.token, status: 'pending', message: '' });
      }
      setRecs(jobs);
      if (!jobs.length) { Toast.warning({ content: '未找到带附件的记录' }); setPrerunning(false); return; }
      for (const job of jobs) {
        if (ac.signal.aborted) break;
        await processJob(job, table, ac, { write: false, useCache: true, forceRefresh: false, effectiveFields, extractMode, parseLimit, onlyEmpty, provider, apiKey, model });
      }
      Toast.success({ content: `后台预提取完成，已缓存 ${jobs.length} 篇；点“开始批量提取”即可秒出` });
    } catch (e: any) {
      Toast.error({ content: `执行出错：${String(e?.message || e)}` });
    } finally {
      setPrerunning(false);
    }
  }, [tableId, attachFieldId, apiKey, model, onlyEmpty, targetFields, extractMode, parseLimit, processJob]);


  const doneCount = recs.filter((r) => r.status === 'done').length;
  const skipCount = recs.filter((r) => r.status === 'skipped').length;
  const statusText: Record<RecState['status'], string> = {
    pending: '等待', downloading: '下载附件', parsing: '解析 PDF',
    generating: 'AI 生成中', done: '✅ 完成', skipped: '⏭️ 已提取，跳过', error: '❌ 失败',
  };

  return (
    <main style={{ padding: 12, fontSize: 13 }}>
      <h4 style={{ margin: '0 0 8px' }}>📚 文献批量阅读器 <span style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>{APP_VER}</span></h4>
        <Banner
        type="info"
        closeIcon={null}
        description="自动读取本表所有“文本”字段作为提取目标，字段名+字段描述即为提示词；按行提取并写回对应字段。解析在本地完成（免费）。结果按记录缓存到浏览器本地：下次同篇直接秒出；也可先“后台预提取”缓存，再秒写。"
      />
      {parsedChars !== null && (
        <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
          上次解析总字符数：{parsedChars.toLocaleString()}
          {textQuality && (
            <span style={{ marginLeft: 8, color: textQuality.ok ? '#2ea44f' : '#d33' }}>
              （可读率 {((textQuality.cjkRatio + textQuality.latinRatio) * 100).toFixed(1)}%{textQuality.ok ? '，正常' : '，异常！'}）
            </span>
          )}
        </div>
      )}
      {textQuality && !textQuality.ok && (
        <Banner
          type="danger"
          closeIcon={null}
          style={{ marginTop: 6 }}
          description={textQuality.reason}
        />
      )}
      {textQuality && (
        <Collapsible style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, color: '#666', background: '#f6f6f6', padding: 8, borderRadius: 6, wordBreak: 'break-all', maxHeight: 160, overflow: 'auto' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>解析文本开头 300 字样本（检查是否乱码）：</div>
            {textQuality.sample || '（空）'}
          </div>
        </Collapsible>
      )}
      {aiReturnPreview && (
        <Collapsible title="AI 返回值详情（调试）" style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, color: '#555', background: '#f6f6f6', padding: 8, borderRadius: 6, wordBreak: 'break-all', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {aiReturnPreview}
          </div>
        </Collapsible>
      )}
      <Form labelPosition="top" style={{ marginTop: 10 }}>
        <Form.Slot label="数据表">
          <Select
            value={tableId}
            onChange={(v) => onTableChange(v as string)}
            style={{ width: '100%' }}
            optionList={tableMetaList.map((t) => ({ label: t.name, value: t.id }))}
          />
        </Form.Slot>
        <Form.Slot label="附件字段（取每个记录的第 1 个附件）">
          <Select
            value={attachFieldId}
            onChange={(v) => setAttachFieldId(v as string)}
            style={{ width: '100%' }}
            placeholder={attachFields.length ? undefined : '当前表没有附件字段'}
            optionList={attachFields}
          />
        </Form.Slot>
        <Form.Slot label="AI 平台">
          <Select
            value={provider}
            onChange={(v) => {
              const p = v as ProviderId;
              setProvider(p);
              setModel(PROVIDERS[p].models[0]);
            }}
            style={{ width: '100%' }}
            optionList={Object.entries(PROVIDERS).map(([k, p]) => ({ label: p.label, value: k }))}
          />
        </Form.Slot>
        <Form.Slot label={`${PROVIDERS[provider].label} API Key`}>
          <Input
            mode="password"
            value={apiKey}
            onChange={(v) => setApiKey(v)}
            placeholder={PROVIDERS[provider].apiKeyPlaceholder}
          />
        </Form.Slot>
        <Form.Slot label="模型">
          <Select
            value={model}
            onChange={(v) => setModel(v as string)}
            style={{ width: '100%' }}
            optionList={PROVIDERS[provider].models.map((m) => ({ label: modelLabel(m), value: m }))}
          />
        </Form.Slot>
        {provider === 'kimi' && (
          <Banner type="info" closeIcon={null} description="Kimi 官方 chat 接口已可浏览器直连（v6.3 修复）。但注意：Kimi 的 /v1/files 上传与读取接口因 CORS 无法在前端直连，本插件仍用浏览器解析 + 模型提取；且 Kimi 模型解码慢（实测约 3 分钟/批），追求速度建议切换到「硅基流动 + DeepSeek-V4-Flash」。" />
        )}
        <Form.Slot label="提取模式">
          <Select
            value={extractMode}
            onChange={(v) => setExtractMode(v as ExtractMode)}
            style={{ width: '100%' }}
            optionList={[
              { label: '精读模式（逐字段精读·并发8·最准·推荐）', value: 'single' },
              { label: '分批模式（每批 5 个字段·均衡）', value: 'chunk' },
              { label: '快速模式（全部字段一次提取·最快≈30秒·字段多易错）', value: 'all' },
            ]}
          />
        </Form.Slot>
        <Form.Slot label="解析字数上限（越小越快越省额度）">
          <Select
            value={parseLimit}
            onChange={(v) => setParseLimit(v as number)}
            style={{ width: '100%' }}
            optionList={[
              { label: '前 8 万字符（推荐，多数字段够用，快）', value: 80000 },
              { label: '完整 15 万字符（最全，较慢）', value: 150000 },
              { label: '前 4 万字符（极速，适合只要标题/作者/摘要类）', value: 40000 },
              { label: '智能分段·不限字数（长文献/书籍，自动切段补漏）', value: 0 },
            ]}
          />
        </Form.Slot>
        <Checkbox checked={onlyEmpty} onChange={(e) => setOnlyEmpty((e.target as any).checked)}>
          仅补提空字段（只提取表里空/无效的字段，已生成的不重提不覆盖；“无”“很抱歉…”等无效值会自动重提覆盖）
        </Checkbox>
        <Checkbox checked={forceRefresh} onChange={(e) => setForceRefresh((e.target as any).checked)}>
          强制重新提取（重新调 AI 全部再提一遍：忽略本地缓存 + 覆盖已有内容）
        </Checkbox>
        <Form.Slot label="已提取判定（批量时整行跳过的条件）">
          <Select
            value={skipThreshold}
            onChange={(v) => setSkipThreshold(v as number)}
            style={{ width: '100%' }}
            optionList={[
              { label: '有 1 个字段有内容即跳过（推荐，提取过就算）', value: 1 },
              { label: '有 3 个字段有内容才跳过', value: 3 },
              { label: '有 5 个字段有内容才跳过', value: 5 },
              { label: '全部字段都有内容才跳过（最严格）', value: 999 },
              { label: '从不跳过（全部重新提取）', value: 0 },
            ]}
          />
        </Form.Slot>
      </Form>

      {targetFields.length > 0 && (
        <Collapsible title={`将提取全部 ${targetFields.length} 个字段（${extractMode === 'all' ? '快速模式' : extractMode === 'chunk' ? '分批模式' : '精读模式'}）`} style={{ margin: '6px 0' }}>
          <ul style={{ margin: 4, paddingLeft: 18, maxHeight: 180, overflowY: 'auto', color: '#555' }}>
            {targetFields.map((f) => (
              <li key={f.fieldId}>
                <b>{f.name}</b>
                {f.description ? ` — ${f.description}` : '（无描述，按字段名提取）'}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}

      <div style={{ display: 'flex', gap: 8, margin: '10px 0', flexWrap: 'wrap' }}>
        <Button theme="solid" type="primary" loading={running} onClick={run}>
          {running
            ? `处理中 ${doneCount}/${recs.length}（跳过 ${skipCount}）`
            : '开始批量提取'}
        </Button>
        {running && <Button onClick={() => abortRef.current?.abort()}>停止</Button>}
        <Button loading={prerunning} onClick={runPreExtract}>
          {prerunning ? `后台预提取中…` : '后台预提取(缓存)'}
        </Button>
      </div>
      {prerunning && (
        <div style={{ fontSize: 12, color: '#666', marginTop: -4 }}>
          后台预提取：逐篇提取并缓存到本地（不写字段）。完成后点“开始批量提取”即可秒出，面板关闭也不丢失。
        </div>
      )}

      {recs.length > 0 && (
        <div style={{ maxHeight: 300, overflowY: 'auto', borderTop: '1px solid #eee' }}>
          {recs.map((r) => (
            <div key={r.recordId} style={{ padding: '6px 0', borderBottom: '1px solid #f2f2f2' }}>
              <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>
                {(r.status === 'downloading' || r.status === 'parsing' || r.status === 'generating') && <Spin size="small" />}
                {' '}{r.name}
              </div>
              <div style={{ color: r.status === 'error' ? '#d45' : '#888' }}>
                {statusText[r.status]}{r.message ? ` · ${r.message}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
