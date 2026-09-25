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
import { extractFieldsAuto, PROVIDERS, ProviderId, TargetField, ExtractMode, isEmptyValue, isTemplateResidue, isDescriptionEcho, modelLabel } from './lib/ai';

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
};

const LS_KEY = 'literature_reader_cfg';
const CACHE_PREFIX = 'litcache:';

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
function getCache(key: string): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.fields && typeof obj.fields === 'object' ? obj.fields : null;
  } catch {
    return null;
  }
}
function setCache(key: string, fields: Record<string, string>) {
  try {
    localStorage.setItem(key, JSON.stringify({ fields, ts: Date.now() }));
  } catch { /* 配额超限忽略 */ }
}

/** 把提取结果逐字段写回表格（保护：单字段失败不影响其他）。只遍历实际提取的 effectiveFields。 */
async function writeFields(
  table: any,
  job: RecState,
  fields: Record<string, string>,
  effectiveFields: TargetField[],
  onlyEmpty: boolean
): Promise<{ successCount: number; failCount: number; emptyCount: number; echoCount: number; existingCount: number; failedFields: string[] }> {
  let successCount = 0, failCount = 0, emptyCount = 0, echoCount = 0, existingCount = 0;
  const failedFields: string[] = [];
  for (const tf of effectiveFields) {
    try {
      const key = Object.keys(fields).find((k) => k.trim().toLowerCase() === tf.name.trim().toLowerCase());
      let v = key ? fields[key] : undefined;
      if (v == null) { emptyCount += 1; continue; }
      v = typeof v === 'string' ? v : String(v);
      if (!v.trim() || isEmptyValue(v) || isTemplateResidue(v)) { emptyCount += 1; continue; }
      if (isDescriptionEcho(v, tf.description)) { echoCount += 1; continue; }
      if (onlyEmpty) {
        const cur = (await table.getRecordById(job.recordId)).fields[tf.fieldId];
        const curStr = Array.isArray(cur) ? cur.map((s: any) => s?.text ?? s ?? '').join('') : String(cur ?? '');
        if (curStr.trim()) { existingCount += 1; continue; }
      }
      await table.setCellValue(tf.fieldId, job.recordId, v.trim());
      successCount += 1;
    } catch (e: any) {
      failCount += 1;
      failedFields.push(tf.name);
    }
  }
  return { successCount, failCount, emptyCount, echoCount, existingCount, failedFields };
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
  // 提取模式：all=全部一次（实测最快）/ chunk=每批7个 / single=单字段逐个
  const [extractMode, setExtractMode] = useState<ExtractMode>('all');
  // 解析字数上限：越小单次 AI 调用越快、越省额度；0=智能分段（不限字数，自动切段补漏）
  const [parseLimit, setParseLimit] = useState<number>(150000);
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  // 已提取判定阈值：有内容的目标字段数 ≥ 阈值即视为"已提取过"，批量时整行跳过；0 = 不跳过
  const [skipThreshold, setSkipThreshold] = useState<number>(1);
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
      if (typeof saved.onlyEmpty === 'boolean') setOnlyEmpty(saved.onlyEmpty);
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
    localStorage.setItem(LS_KEY, JSON.stringify({ provider: p, apiKey: k, model: m, onlyEmpty: oe }));
  };

  // 单条记录处理：缓存命中则秒出；否则 下载→解析→AI提取→（可选）写回→缓存
  const processJob = useCallback(async (
    job: RecState,
    table: any,
    ac: AbortController,
    opts: {
      write: boolean; useCache: boolean; forceRefresh: boolean;
      effectiveFields: TargetField[]; extractMode: ExtractMode; parseLimit: number;
      onlyEmpty: boolean; provider: ProviderId; apiKey: string; model: string;
    }
  ) => {
    const setState = (patch: Partial<RecState>) =>
      setRecs((prev) => prev.map((r) => (r.recordId === job.recordId ? { ...r, ...patch } : r)));
    const key = cacheKey(job.recordId, job.token);
    // 缓存值有效性：非空、非模板残留、非描述回声
    const cachedValid = (v: string | undefined, desc: string) => {
      if (!v || !v.trim() || isEmptyValue(v) || isTemplateResidue(v)) return false;
      return !isDescriptionEcho(v, desc);
    };
    // 1) 缓存命中 → 完整命中秒出；部分命中（如旧版快速模式只缓存了核心字段）→ 只补提缺失字段
    let partialCached: Record<string, string> | null = null;
    let partialMissing: TargetField[] | null = null;
    if (opts.useCache && !opts.forceRefresh) {
      const cached = getCache(key);
      if (cached) {
        const missing = opts.effectiveFields.filter((f) => {
          const k = Object.keys(cached).find((ck) => ck.trim().toLowerCase() === f.name.trim().toLowerCase());
          return !cachedValid(k ? cached[k] : undefined, f.description);
        });
        if (missing.length === 0) {
          if (opts.write) {
            const w = await writeFields(table, job, cached, opts.effectiveFields, opts.onlyEmpty);
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
      const extractList = partialMissing ?? opts.effectiveFields;
      setState({ status: 'generating', message: `${partialCached ? `缓存补提缺失 ${extractList.length} 字段 · ` : ''}AI 生成中（${pages} 页 / ${text.length.toLocaleString()} 字符 / ${extractList.length} 字段${truncated ? '，已截断' : ''}）` });
      const startedAt = Date.now();
      let segInfo = '';
      const timer = setInterval(() => {
        const sec = Math.round((Date.now() - startedAt) / 1000);
        setState({ status: 'generating', message: `AI 生成中${segInfo ? `（${segInfo}）` : ''} · 已 ${sec} 秒` });
      }, 3000);
      let extractResult: { fields: Record<string, string>; raws: string[] };
      try {
        extractResult = await extractFieldsAuto(text, extractList, { provider: opts.provider, apiKey: opts.apiKey, model: opts.model }, ac.signal, opts.extractMode, (i, n) => { segInfo = `第 ${i}/${n} 段`; });
      } finally { clearInterval(timer); }
      const { fields, raws } = extractResult;
      // 与旧缓存合并（新结果优先），缓存始终保存“目前已知最全”的字段集
      const mergedFields: Record<string, string> = { ...(partialCached ?? {}), ...fields };
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`;
      setAiReturnPreview(
        (raws.length ? `===== AI 原始返回 =====\n${raws.join('\n\n')}\n\n` : '') +
        '===== 解析后的字段值 =====\n' +
        Object.entries(fields).map(([k, v]) => `${k} = ${(typeof v === 'string' ? v : String(v)).slice(0, 30)}${(typeof v === 'string' ? v : String(v)).length > 30 ? '…' : ''}`).join('\n')
      );
      setCache(key, mergedFields);
      if (opts.write) {
        const w = await writeFields(table, job, mergedFields, opts.effectiveFields, opts.onlyEmpty);
        const parts = [`${partialCached ? '缓存补提后写入' : '写入'} ${w.successCount}/${opts.effectiveFields.length}`];
        if (w.emptyCount) parts.push(`AI未给 ${w.emptyCount}`);
        if (w.echoCount) parts.push(`过滤回声 ${w.echoCount}`);
        if (w.existingCount) parts.push(`已有跳过 ${w.existingCount}`);
        if (w.failCount) parts.push(`失败 ${w.failCount}：${w.failedFields.join('、')}`);
        setState({ status: 'done', message: `${parts.join('，')}，耗时 ${elapsedStr}`, successCount: w.successCount, failCount: w.failCount });
      } else {
        setState({ status: 'done', message: `已缓存 · 共 ${Object.keys(mergedFields).length} 字段（本次新提 ${Object.keys(fields).length}），耗时 ${elapsedStr}`, successCount: Object.keys(mergedFields).length });
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') { setState({ status: 'error', message: '已停止' }); return; }
      setState({ status: 'error', message: String(e?.message || e).slice(0, 500), failCount: opts.effectiveFields.length, failedFields: opts.effectiveFields.map((f) => f.name) });
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
      // 预扫：已提取过的行整行跳过（只统计本次实际要提取的字段；强制重新提取时不跳过）
      const prescan = await Promise.all(recordIds.map(async (rid) => {
        const rec = await table.getRecordById(rid);
        const atts = (rec.fields as any)[attachFieldId] as any[] | undefined;
        if (!atts?.[0]?.token) return { filled: 0, extracted: false };
        if (!effOnlyEmpty || skipThreshold === 0) return { filled: 0, extracted: false };
        let filled = 0;
        for (const tf of effectiveFields) {
          const cur = (rec.fields as any)[tf.fieldId];
          const curStr = (Array.isArray(cur) ? cur.map((s: any) => s?.text ?? s ?? '').join('') : String(cur ?? '')).trim();
          if (curStr && !isEmptyValue(curStr) && !isTemplateResidue(curStr)) filled += 1;
        }
        return { filled, extracted: filled >= skipThreshold };
      }));
      const jobs: RecState[] = [];
      for (let i = 0; i < recordIds.length; i++) {
        const rec = await table.getRecordById(recordIds[i]);
        const first = (rec.fields as any)[attachFieldId]?.[0];
        if (!first?.token) continue;
        if (prescan[i].extracted) {
          jobs.push({ recordId: recordIds[i], name: first.name || '未命名附件', status: 'skipped', message: `已提取过（${prescan[i].filled}/${effectiveFields.length} 个字段已有内容），跳过`, skipped: true });
        } else {
          jobs.push({ recordId: recordIds[i], name: first.name || '未命名附件', token: first.token, status: 'pending', message: '' });
        }
      }
      setRecs(jobs);
      if (!jobs.length) { Toast.warning({ content: '未找到带附件的记录' }); setRunning(false); return; }
      for (const job of jobs) {
        if (ac.signal.aborted) break;
        if (job.skipped) continue;
        await processJob(job, table, ac, { write: true, useCache: true, forceRefresh, effectiveFields, extractMode, parseLimit, onlyEmpty: effOnlyEmpty, provider, apiKey, model });
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
      <h4 style={{ margin: '0 0 8px' }}>📚 文献批量阅读器</h4>
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
              { label: '快速模式（全部字段一次提取·最快≈30秒·推荐）', value: 'all' },
              { label: '分批模式（每批 7 个字段·均衡）', value: 'chunk' },
              { label: '精读模式（逐字段精读·最准最慢）', value: 'single' },
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
          仅填充空字段（已有内容的字段不覆盖）
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
