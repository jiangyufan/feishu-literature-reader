// AI 生成层：OpenAI 兼容接口（v1 默认硅基流动直连；Kimi 官方需代理，后接）
export interface TargetField {
  name: string;       // 字段名
  fieldId: string;    // 字段 ID（用于写回）
  description: string; // 字段描述（可选，来自表里的"提示词"或字段名本身）
}

export interface AiConfig {
  provider: 'siliconflow';
  apiKey: string;
  model: string;
}

export const PROVIDERS = {
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Pro/moonshotai/Kimi-K2.6', 'moonshotai/Kimi-K2.7-Code'],
  },
};

/** 动态构建提示词：把用户定义的字段名+描述一起传给 AI */
function buildPrompt(text: string, fields: TargetField[]): { system: string; user: string } {
  const fieldList = fields.map((f, i) => {
    const desc = f.description || f.name;
    return `${i + 1}. **${f.name}**（要求：${desc}）`;
  }).join('\n');
  return {
    system: `你是一位学术文献阅读助手。下面是一份文献（论文、专著或整本书）经解析得到的全文文本，可能存在解析噪声。请基于文本内容如实作答，禁止编造文本中没有的信息。`,
    user: `请从以下文献全文中提取以下字段的内容，严格输出 JSON（不要任何多余说明、不要 markdown 代码块以外的内容）：\n${fieldList}\n\n要求：\n- 所有字段用简体中文填写（英文标题保留原文）；\n- 若某字段在文中确实无法确定，填 "未提及"；\n- JSON 键名必须严格使用上面的字段名（包括中文名称）。`,
  };
}

/** 容错解析模型返回的 JSON（处理 ```json 包裹、前后噪声） */
export function parseFieldsJson(raw: string): Record<string, string> {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

/** 调用 OpenAI 兼容 chat/completions 提取字段 */
export async function extractFields(
  text: string,
  fields: TargetField[],
  cfg: AiConfig,
  signal?: AbortSignal
): Promise<{ fields: Record<string, string>; usage: any }> {
  const { system, user } = buildPrompt(text, fields);
  const base = PROVIDERS[cfg.provider].baseUrl;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
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
  const fieldsResult = parseFieldsJson(content);
  return { fields: fieldsResult, usage: data?.usage };
}
