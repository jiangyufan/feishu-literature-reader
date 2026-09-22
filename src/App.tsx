import './App.css';
import { bitable, FieldType, ITableMeta } from '@lark-base-open/js-sdk';
import {
  Button,
  Form,
  Input,
  Select,
  Banner,
  Spin,
  Toast,
} from '@douyinfe/semi-ui';
import { useState, useEffect, useRef, useCallback } from 'react';
import { parsePdf } from './lib/pdf';
import { extractFields, PROVIDERS } from './lib/ai';
import { EXTRACTION_FIELDS } from './lib/fields';

type RecState = {
  recordId: string;
  name: string;
  token?: string;
  status: 'pending' | 'downloading' | 'parsing' | 'generating' | 'done' | 'error';
  message: string;
};

const LS_KEY = 'literature_reader_cfg';

export default function App() {
  const [tableMetaList, setTableMetaList] = useState<ITableMeta[]>([]);
  const [tableId, setTableId] = useState<string>();
  const [attachFieldId, setAttachFieldId] = useState<string>();
  const [attachFields, setAttachFields] = useState<{ label: string; value: string }[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(PROVIDERS.siliconflow.models[0]);
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
        loadAttachFields(tid);
      })
      .catch((e) => Toast.error({ content: `初始化失败：${String(e)}` }));
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (saved.apiKey) setApiKey(saved.apiKey);
      if (saved.model) setModel(saved.model);
    } catch { /* ignore */ }
  }, []);

  const loadAttachFields = useCallback(async (tid?: string) => {
    if (!tid) return;
    try {
      const table = await bitable.base.getTableById(tid);
      const metas = await table.getFieldMetaList();
      const atts = metas
        .filter((m) => (m as any).type === FieldType.Attachment)
        .map((m) => ({ label: m.name, value: m.id }));
      setAttachFields(atts);
      if (atts.length && !atts.find((a) => a.value === attachFieldId)) {
        setAttachFieldId(atts[0].value);
      }
    } catch { /* ignore */ }
  }, [attachFieldId]);

  const onTableChange = (tid: string) => {
    setTableId(tid);
    setAttachFieldId(undefined);
    loadAttachFields(tid);
  };

  const saveCfg = (k: string, m: string) => {
    localStorage.setItem(LS_KEY, JSON.stringify({ apiKey: k, model: m }));
  };

  /** 确保 9 个目标字段存在，返回 name->fieldId */
  const ensureFields = useCallback(async (tid: string) => {
    const table = await bitable.base.getTableById(tid);
    const metas = await table.getFieldMetaList();
    const map: Record<string, string> = {};
    for (const m of metas) {
      if (EXTRACTION_FIELDS.some((f) => f.name === m.name)) map[m.name] = m.id;
    }
    for (const f of EXTRACTION_FIELDS) {
      if (!map[f.name]) {
        const res: any = await table.addField({ type: FieldType.Text, name: f.name });
        map[f.name] = typeof res === 'string' ? res : res?.fieldId;
      }
    }
    return map;
  }, []);

  const run = useCallback(async () => {
    if (!tableId || !attachFieldId) {
      Toast.warning({ content: '请先选择数据表和附件字段' });
      return;
    }
    if (!apiKey) {
      Toast.warning({ content: '请填写硅基流动 API Key' });
      return;
    }
    saveCfg(apiKey, model);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const fieldMap = await ensureFields(tableId);
      const table = await bitable.base.getTableById(tableId);
      const recordIds = await table.getRecordIdList();
      // 只处理附件字段非空的记录
      const jobs: RecState[] = [];
      for (const rid of recordIds) {
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
        try {
          // 1. 取附件临时链接并下载
          setState(job.recordId, { status: 'downloading', message: '下载附件' });
          const urls = await table.getCellAttachmentUrls(
            [job.token as string],
            attachFieldId,
            job.recordId
          );
          if (!urls?.length) throw new Error('获取附件链接失败');
          const blob = await (await fetch(urls[0])).blob();

          // 2. 本地解析 PDF
          setState(job.recordId, { status: 'parsing', message: '解析 PDF' });
          const buf = await blob.arrayBuffer();
          const { text, pages, truncated } = await parsePdf(buf, { maxChars: 150000 });
          if (text.trim().length < 50) throw new Error('PDF 几乎无文本层（可能是纯扫描件），暂不支持');

          // 3. 调 AI 提取字段
          setState(job.recordId, {
            status: 'generating',
            message: `AI 生成中（${pages} 页${truncated ? '，已截断' : ''}）`,
          });
          const { fields } = await extractFields(text, { provider: 'siliconflow', apiKey, model }, ac.signal);

          // 4. 写回字段
          for (const f of EXTRACTION_FIELDS) {
            const v = fields[f.name];
            if (typeof v === 'string' && v && fieldMap[f.name]) {
              await table.setCellValue(fieldMap[f.name], job.recordId, v);
            }
          }
          setState(job.recordId, { status: 'done', message: '完成' });
        } catch (e: any) {
          if (e?.name === 'AbortError') break;
          setState(job.recordId, { status: 'error', message: String(e?.message || e).slice(0, 200) });
        }
      }
    } catch (e: any) {
      Toast.error({ content: `执行出错：${String(e?.message || e)}` });
    } finally {
      setRunning(false);
    }
  }, [tableId, attachFieldId, apiKey, model, ensureFields]);

  const doneCount = recs.filter((r) => r.status === 'done').length;
  const statusText: Record<RecState['status'], string> = {
    pending: '等待', downloading: '下载附件', parsing: '解析 PDF',
    generating: 'AI 生成中', done: '✅ 完成', error: '❌ 失败',
  };

  return (
    <main style={{ padding: 12, fontSize: 13 }}>
      <h4 style={{ margin: '0 0 8px' }}>📚 文献批量阅读器</h4>
      <Banner
        type="info"
        closeIcon={null}
        description={`解析在本地完成（免费）；AI 生成走${PROVIDERS.siliconflow.label}，按量计费，大文档约 ¥0.5~1.5/篇`}
      />
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
        <Form.Slot label="硅基流动 API Key">
          <Input
            mode="password"
            value={apiKey}
            onChange={(v) => setApiKey(v)}
            placeholder="sk-..."
          />
        </Form.Slot>
        <Form.Slot label="模型">
          <Select
            value={model}
            onChange={(v) => setModel(v as string)}
            style={{ width: '100%' }}
            optionList={PROVIDERS.siliconflow.models.map((m) => ({ label: m, value: m }))}
          />
        </Form.Slot>
      </Form>

      <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        <Button theme="solid" type="primary" loading={running} onClick={run}>
          {running ? `处理中 ${doneCount}/${recs.length}` : '开始批量提取'}
        </Button>
        {running && (
          <Button onClick={() => abortRef.current?.abort()}>停止</Button>
        )}
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
                {statusText[r.status]}{r.message && r.status !== 'done' ? ` · ${r.message}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
