/**
 * dsh-composer-polish —— Host 半。
 *
 * 职责只有一个：注册一个 exact HTTP 端点，把「输入框草稿」交给当前会话的默认模型，
 * 让它先判断使用者意图、再产出润色后的提示词，回给浏览器半（client.js）。
 *
 * 为什么不用 Connection RPC：本机 dsh-liuyao 的实测结论是，插件自有前缀走 RPC 通道时
 * 回调可能不触发，POST 会落到前端静态兜底并返回 405。webServer 的 exact 端点则总是
 * 优先于静态兜底，稳定可控；代价是要自己做同源门禁 + 请求体上限 + JSON 校验。
 */

const API_PATH = '/dsh-composer-polish/polish'
const MAX_BODY = 64 * 1024
const MAX_DRAFT = 12000

/** 润色提示词的 system 段：先推意图，再改写；只认 JSON 输出。 */
const SYSTEM_PROMPT = [
  '你是提示词工程师，工作在一个 AI 客户端的输入框旁边。',
  '使用者刚在输入框里起了个头：可能口语、零散、有错别字、缺上下文，也可能已经写得很完整。',
  '',
  '你的任务分两步：',
  '1. 判断使用者真正想达成什么（意图），用一句话说清。',
  '2. 把草稿改写成一条高质量提示词：结构清晰、信息完整、指代明确，AI 拿到就能直接干活。',
  '',
  '输出格式（硬性要求）：只输出一个 JSON 对象，不要代码围栏、不要任何前后解释：',
  '{"intent": "意图概括，不超过 40 字", "polished": "润色后的提示词"}',
  '',
  '改写规则：',
  '- polished 的语言与草稿一致：中文草稿输出中文，英文草稿输出英文。',
  '- 草稿里的专有名词、路径、文件名、标识符、数字、代码、命令、URL 必须一字不改地保留。',
  '- 不新增使用者没要求的工作，不改变原意，不扩大范围，不替使用者预设结论。',
  '- 删掉寒暄、重复和口头语；含糊的表达写成具体要求，但不能臆造事实。',
  '- 草稿已足够清晰时只做最小必要改写，不要为了显得专业而膨胀篇幅。',
  '- polished 直接写成使用者对 AI 说的话，不要出现「使用者想…」这类第三人称转述。',
  '- polished 里不要出现表情符号，也不要把任务的执行结果写进去。',
].join('\n')

const sendJson = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 只接受同源请求：优先看 Sec-Fetch-Site，退化到 Origin/Host 比对。 */
const sameOrigin = (req) => {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === req.headers.host } catch (error) { return false }
}

const readJsonBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return }
    chunks.push(chunk)
  })
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw === '') { resolve({}); return }
    try { resolve(JSON.parse(raw)) } catch (error) { reject(new Error('请求体不是合法 JSON')) }
  })
  req.on('error', reject)
})

/** 模型有时仍会裹代码围栏或加前后缀：取出最外层 JSON 对象。 */
const extractJson = (text) => {
  const raw = String(text ?? '').trim()
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    return null
  }
}

/** 当前会话默认模型（读不到就返回 null）。 */
const resolveTarget = (ctx) => {
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection === null || typeof selection !== 'object') return null
  const provider = typeof selection.provider === 'string' ? selection.provider : ''
  const model = typeof selection.model === 'string' ? selection.model : ''
  if (provider === '' || model === '') return null
  return {
    provider,
    model,
    ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
  }
}

/** 流式收集完整文本。prepared.config 必须原样展平回传，否则适配器抛 INVALID_PREPARED_CALL。 */
const collectStream = async (prepared, { system, messages }) => {
  let acc = ''
  for await (const chunk of prepared.stream({ ...prepared.config, system, messages })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) acc += chunk.text
    else if (chunk?.type === 'finish' && chunk.reason?.kind && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'tool-calls') {
      const reason = chunk.reason
      throw new Error(`生成未正常结束：${reason.kind}${reason.failure?.message ? `（${reason.failure.message}）` : ''}`)
    }
  }
  return acc
}

export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    ctx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') { res.writeHead(204, { allow: 'POST, OPTIONS' }); res.end(); return }
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed: use POST' }); return }
        if (!sameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request refused' }); return }

        let payload
        try { payload = await readJsonBody(req) } catch (error) { sendJson(res, 400, { ok: false, error: String(error?.message ?? error) }); return }

        const draft = String(payload?.draft ?? '').trim()
        if (draft === '') { sendJson(res, 400, { ok: false, error: '输入框是空的，先写点东西再润色' }); return }
        const clipped = draft.length > MAX_DRAFT
          ? draft.slice(0, MAX_DRAFT)
          : draft

        const llm = ctx.get('llm')
        if (llm === undefined) { sendJson(res, 503, { ok: false, error: '本机未挂载模型服务（llm），暂时无法润色' }); return }

        const target = resolveTarget(ctx)
        if (target === null) { sendJson(res, 503, { ok: false, error: '未能确定可用模型：请先在模型选择器里选定一个模型' }); return }

        // 输出上限与采样温度一并省略：交给适配器的默认值，避免 prepareCall 对模型的
        // 上下文窗口/采样范围做校验时直接失败（不同 provider 的上限不一致）。
        let prepared
        try {
          prepared = await llm.prepareCall({
            provider: target.provider,
            model: target.model,
            ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
          })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: `模型准备失败：${String(error?.message ?? error)}` }); return
        }

        let text
        try {
          text = await collectStream(prepared, {
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: [{ type: 'text', text: clipped }] }],
          })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: `润色失败：${String(error?.message ?? error)}` }); return
        }

        const parsed = extractJson(text)
        const polished = typeof parsed?.polished === 'string' ? parsed.polished.trim() : text.trim()
        if (polished === '') { sendJson(res, 502, { ok: false, error: '模型没有返回可用的润色结果' }); return }

        sendJson(res, 200, {
          ok: true,
          intent: typeof parsed?.intent === 'string' ? parsed.intent.trim() : '',
          polished,
          original: clipped,
          provider: target.provider,
          model: target.model,
          truncated: clipped.length !== draft.length,
        })
      },
    }), `dsh-composer-polish: POST ${API_PATH}`)
  })
}
