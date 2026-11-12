/**
 * POST /api/name
 * 作用：接收用户起名需求 → 调用大模型（流式）→ 边生成边返回 → 结束后写入 Supabase 历史
 *
 * 设计要点：
 * 1. 所有模型共用一套调用代码，差异只写在 modelConfigMap 里（只加配置、不改逻辑）
 * 2. 密钥全部从环境变量读取，代码里不出现任何明文 key
 * 3. 输出用 SSE（text/event-stream），前端可以逐字显示
 */
const { createClient } = require('@supabase/supabase-js');

// ============ 模型配置表：新增模型只在这里加一项 ============
const modelConfigMap = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  doubao: {
    label: '豆包（火山方舟）',
    // 火山方舟 OpenAI 兼容地址为 /api/v3（旧资料里的 /api/v1 已不可用）
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnv: 'DOUBAO_API_KEY',
    // 这里要填火山方舟控制台里的「推理接入点 ID」，也可以在环境变量里配置
    model: process.env.DOUBAO_MODEL_ID || 'doubao-seed-1-6-250615',
  },
  qwen: {
    label: '通义千问',
    // 注意：必须用 compatible-mode 兼容模式地址，普通 DashScope 地址不兼容 OpenAI 协议
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'QWEN_API_KEY',
    model: process.env.QWEN_MODEL || 'qwen-plus',
  },
  kimi: {
    label: 'Kimi（月之暗面）',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'KIMI_API_KEY',
    model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
  },
};

const SYSTEM_PROMPT = `你是一位精通中文姓名文化、字义与音律的起名专家。
请严格按下面规则输出，不要写开场白、不要写总结寒暄、不要输出与起名无关的内容：

1. 根据用户给出的性别、风格、姓氏、寓意偏好等条件，给出恰好 3 组名字方案。
2. 每组严格使用如下格式：

### 1. 名字
- 寓意：用 2~3 句话解释这个名字的出处或字义、整体气质
- 适合：一句话说明适合什么样的人/气质

3. 第 2、3 组依次编号，格式完全一致。
4. 如果用户要英文名，则给出英文名，并在寓意中解释其含义与来源。
5. 名字要真实可用、避免生僻字堆砌、避免与要求冲突（如用户限定两字名就不要给三字名）。`;

// ============ Supabase 客户端（懒加载，没配置也能跑通起名功能） ============
function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  // 服务端写入优先用 service_role（可绕过 RLS）；没有就退回 anon key
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: '只支持 POST 请求' });
    return;
  }

  // Vercel 会自动解析 JSON body；本地 dev-server 也已解析
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const requirement = String(body.requirement || '').trim();
  const modelKey = String(body.model || 'deepseek').trim();

  if (!requirement) {
    res.status(400).json({ error: '请先填写起名需求' });
    return;
  }
  if (requirement.length > 500) {
    res.status(400).json({ error: '起名需求请控制在 500 字以内' });
    return;
  }

  const cfg = modelConfigMap[modelKey];
  if (!cfg) {
    res.status(400).json({ error: `不支持的模型：${modelKey}` });
    return;
  }

  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    res.status(400).json({ error: `模型「${cfg.label}」未配置密钥，请在环境变量中设置 ${cfg.apiKeyEnv}` });
    return;
  }

  // 建立 SSE 连接
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  sendEvent(res, { type: 'meta', model: modelKey, label: cfg.label });

  // 客户端断开时，同步中断上游请求，避免白烧 token
  const controller = new AbortController();
  let finished = false;
  req.on('close', () => {
    if (!finished) controller.abort();
  });

  let fullText = '';
  let savedId = null;
  let saveError = null;

  try {
    const upstream = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        temperature: 0.8,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: requirement },
        ],
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      throw new Error(`上游接口返回 ${upstream.status}：${errText.slice(0, 200) || upstream.statusText}`);
    }

    // 解析上游 SSE 分片
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let done = false;

    while (!done) {
      const { value, done: upstreamDone } = await reader.read();
      if (upstreamDone) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 最后一行可能不完整，留到下次

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          done = true;
          break;
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            sendEvent(res, { type: 'delta', text: delta });
          }
        } catch {
          // 忽略不完整/非 JSON 分片（心跳、注释等）
        }
      }
    }

    // ============ 生成结束，写入 Supabase ============
    const supabase = getSupabaseClient();
    if (supabase && fullText.trim()) {
      const { data, error } = await supabase
        .from('name_history')
        .insert({
          user_requirement: requirement,
          name_result: fullText,
          model_name: modelKey,
        })
        .select('id')
        .single();
      if (error) saveError = error.message;
      else savedId = data?.id ?? null;
    } else if (!supabase) {
      saveError = '未配置 SUPABASE_URL / SUPABASE_ANON_KEY，本次结果未写入数据库';
    }

    finished = true;
    sendEvent(res, { type: 'done', id: savedId, saveError, chars: fullText.length });
    res.end();
  } catch (err) {
    finished = true;
    if (err.name === 'AbortError') {
      res.end();
      return;
    }
    sendEvent(res, { type: 'error', message: err.message || '生成失败，请稍后重试' });
    res.end();
  }
};

// Vercel 函数最长执行时间（秒）
module.exports.config = { maxDuration: 60 };
