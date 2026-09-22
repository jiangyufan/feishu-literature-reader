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
import { parsePdf } from './lib/pdf';
import { extractFields, PROVIDERS, ProviderId, TargetField, isEmptyValue, isTemplateResidue, isDescriptionEcho } from './lib/ai';

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
  const [onlyEmpty, setOnlyEmpty] = useState(true);
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

  const run = useCallback(async () => {
    if (!tableId || !attachFieldId) {
      Toast.warning({ content: '请先选择数据表和附件字段' });
      return;
    }
    if (!apiKey) {
      Toast.warning({ content: `请填写 ${PROVIDERS[provider].label} API Key` });
      return;
    }
    if (provider === 'kimi') {
      Toast.warning({ content: 'Kimi 官方 API 暂未开放浏览器直连，请先用硅基流动模型' });
      return;
    }
    if (!targetFields.length) {
      Toast.warning({ content: '当前表没有可提取的文本字段（请先建好带提示词的文本字段）' });
      return;
    }
    saveCfg(provider, apiKey, model, onlyEmpty);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const table = await bitable.base.getTableById(tableId);
      const recordIds = await table.getRecordIdList();
      
      // 预扫记录：检查哪些行已全部提取过（所有目标字段都非空）
      const allFieldsFilled = await Promise.all(
        recordIds.map(async (rid) => {
          const rec = await table.getRecordById(rid);
          const atts = (rec.fields as any)[attachFieldId] as any[] | undefined;
          const hasAttachment = atts?.[0]?.token;
          if (!hasAttachment) return false;
          if (!onlyEmpty) return true; // 如果允许覆盖，不跳过任何行
          // 检查所有目标字段是否都已填充
          for (const tf of targetFields) {
            const cur = (rec.fields as any)[tf.fieldId];
            const curStr = Array.isArray(cur)
              ? cur.map((s: any) => s?.text ?? s ?? '').join('')
              : String(cur ?? '');
            if (!curStr.trim()) return false; // 至少有一个字段为空
          }
          return true; // 所有字段都已填
        })
      );

      const jobs: RecState[] = [];
      const skipped: string[] = [];
      for (let i = 0; i < recordIds.length; i++) {
        const rid = recordIds[i];
        if (!allFieldsFilled[i]) {
          const rec = await table.getRecordById(rid);
          const atts = (rec.fields as any)[attachFieldId] as any[] | undefined;
          const first = atts?.[0];
          if (first?.token) {
            jobs.push({
              recordId: rid,
              name: first.name || '未命名附件',
              token: first.token,
              status: 'pending',
              message: '',
            });
          }
        } else {
          // 已提取完，跳过
          const rec = await table.getRecordById(rid);
          const atts = (rec.fields as any)[attachFieldId] as any[] | undefined;
          const name = atts?.[0]?.name || '未命名附件';
          skipped.push(rid);
          jobs.push({
            recordId: rid,
            name,
            status: 'skipped',
            message: '已提取，跳过',
            skipped: true,
          });
        }
      }
      setRecs(jobs);
      if (!jobs.length) {
        Toast.warning({ content: '未找到带附件的记录' });
        setRunning(false);
        return;
      }

      const setState = (rid: string, patch: Partial<RecState>) => {
        setRecs((prev) => prev.map((r) => (r.recordId === rid ? { ...r, ...patch } : r)));
      };

      for (const job of jobs) {
        if (ac.signal.aborted) break;
        if (job.skipped) continue; // 跳过已提取的行

        try {
          setState(job.recordId, { status: 'downloading', message: '下载附件' });
          const urls = await table.getCellAttachmentUrls([job.token as string], attachFieldId, job.recordId);
          if (!urls?.length) throw new Error('获取附件链接失败');
          const blob = await (await fetch(urls[0])).blob();

          setState(job.recordId, { status: 'parsing', message: '解析 PDF' });
          const buf = await blob.arrayBuffer();
          const { text, pages, truncated } = await parsePdf(buf, { maxChars: 150000 });
          if (text.trim().length < 50) throw new Error('PDF 几乎无文本层（可能是纯扫描件），暂不支持');
          setParsedChars(text.length);

          setState(job.recordId, {
            status: 'generating',
            message: `AI 生成中（${pages} 页 / ${text.length.toLocaleString()} 字符 / ${targetFields.length} 字段${truncated ? '，已截断' : ''}）`,
          });
          const { fields } = await extractFields(text, targetFields, { provider, apiKey, model }, ac.signal);

          // 诊断：把 AI 返回的 key 列出来，便于排查字段名不匹配
          const returnedKeys = Object.keys(fields)
            .slice(0, 30)
            .map((k) => `"${k}"`)
            .join(', ');

          // 逐字段写回（保护：单个字段失败不影响其他字段）
          let successCount = 0;
          let failCount = 0;
          let filteredCount = 0;
          const failedFields: string[] = [];
          const filteredFields: string[] = [];

          for (const tf of targetFields) {
            try {
              const key = Object.keys(fields).find(
                (k) => k.trim().toLowerCase() === tf.name.trim().toLowerCase()
              );
              let v = key ? fields[key] : undefined;
              if (typeof v === 'string') {
                // keep string
              } else if (v != null && typeof (v as any).toString === 'function') {
                v = (v as any).toString();
              } else {
                v = String(v ?? '');
              }
              if (!v || !v.trim() || isEmptyValue(v) || isTemplateResidue(v) || isDescriptionEcho(v, tf.description)) {
                filteredCount += 1;
                filteredFields.push(tf.name);
                continue;
              }
              if (onlyEmpty) {
                const cur = (await table.getRecordById(job.recordId)).fields[tf.fieldId];
                const curStr = Array.isArray(cur)
                  ? cur.map((s: any) => s?.text ?? s ?? '').join('')
                  : String(cur ?? '');
                if (curStr.trim()) {
                  filteredCount += 1;
                  filteredFields.push(tf.name);
                  continue; // 已有内容则跳过
                }
              }
              await table.setCellValue(tf.fieldId, job.recordId, v.trim());
              successCount += 1;
            } catch (e: any) {
              failCount += 1;
              failedFields.push(tf.name);
            }
          }

          const diag = `AI 返回字段名：[${returnedKeys}]`;
          const parts: string[] = [`写入 ${successCount}/${targetFields.length}`];
          if (filteredCount > 0) parts.push(`过滤 ${filteredCount} 个（空/模板残留/已有内容）`);
          if (failCount > 0) parts.push(`失败 ${failCount} 个：${failedFields.join('、')}`);
          setState(job.recordId, {
            status: 'done',
            message: `${parts.join('，')}（${text.length.toLocaleString()} 字符）；${diag}`,
            successCount,
            failCount,
          });
        } catch (e: any) {
          if (e?.name === 'AbortError') break;
          // 显示详细错误信息（含 AI 原始回复）
          const msg = String(e?.message || e).slice(0, 500);
          setState(job.recordId, {
            status: 'error',
            message: msg,
            failCount: targetFields.length,
            failedFields: targetFields.map(f => f.name),
          });
        }
      }
    } catch (e: any) {
      Toast.error({ content: `执行出错：${String(e?.message || e)}` });
    } finally {
      setRunning(false);
    }
  }, [tableId, attachFieldId, apiKey, model, onlyEmpty, targetFields]);

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
        description="自动读取本表所有“文本”字段作为提取目标，字段名+字段描述即为提示词；按行一次提取全部，写回对应字段。解析在本地完成（免费）。"
      />
      {parsedChars !== null && (
        <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
          上次解析总字符数：{parsedChars.toLocaleString()}
        </div>
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
            optionList={PROVIDERS[provider].models.map((m) => ({ label: m, value: m }))}
          />
        </Form.Slot>
        {provider === 'kimi' && (
          <Banner type="warning" closeIcon={null} description="Kimi 官方 API 暂未开放浏览器直连（CORS 限制），当前仅作配置预留，正式接入需后端代理。" />
        )}
        <Checkbox checked={onlyEmpty} onChange={(e) => setOnlyEmpty((e.target as any).checked)}>
          仅填充空字段（已有内容的字段不覆盖）
        </Checkbox>
      </Form>

      {targetFields.length > 0 && (
        <Collapsible title={`将提取 ${targetFields.length} 个字段`} style={{ margin: '6px 0' }}>
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

      <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        <Button theme="solid" type="primary" loading={running} onClick={run}>
          {running
            ? `处理中 ${doneCount}/${recs.length}（跳过 ${skipCount}）`
            : '开始批量提取'}
        </Button>
        {running && <Button onClick={() => abortRef.current?.abort()}>停止</Button>}
      </div>

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
