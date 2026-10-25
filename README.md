# dsh-composer-polish · 对话框「润色」按钮

在 composer 工具行里、「权限」按钮右边加一个按钮：读你输入框里已经写好的草稿，
先让模型判断你想干什么，再把草稿改写成一条高质量提示词。润色完成后按钮变成
「取消」，按一下就回退到润色前的原文。

> A **Polish** button for the DeepSeek Harness composer tool row, placed right of the
> permission control. It reads the draft you have already typed, infers your intent,
> rewrites the draft into a clearer prompt, and turns into a **Cancel** button that
> restores the exact pre-polish text in one click.

## 落位

`conversation.input.left` —— composer 工具行里 `.modes` 容器（权限 / 计划按钮）之后的
list seat，渲染点就在权限按钮右边：

```text
[ + ]  [ 权限 ][ 计划 ]  [ 润色 ]        …  [ 模型 ] [ 发送 ]
        └── .modes ──┘  └ input.left ┘
```

DOM 依据：`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:19220-19256`：

```js
children: [ 加号按钮,
  { className: 'modes', children: [renderSlot('conversation.input.permission', {locked}),
                                   renderSlot('conversation.input.plan', {locked})] },
  renderSlot('conversation.input.left', {}) ]
```

## 交互

| 状态 | 按钮 | 行为 |
| --- | --- | --- |
| `idle` | 润色 | 读 `InputState.draft` → `POST /dsh-composer-polish/polish` → 模型推断意图并润色 → `inputActions.setDraft(结果)` |
| `busy` | 润色中… | 请求在途，按钮禁用（请求超时 120s） |
| `done` | 取消 | `inputActions.setDraft(润色前的原文)`，回到 `idle` |
| `error` | 重试 | title 显示失败原因，点一下重试 |

细节：

- 输入框为空时按钮禁用（没什么可润色）。
- 请求期间如果你自己又改了草稿，回来时不会覆盖你的新输入（按草稿快照比对）。
- 处于「取消」态时只要你手改了草稿（或发送清空、切换会话），回退锚点立即失效、
  按钮退回「润色」——不会把旧原文硬塞回一个已经被改过的输入框。
- 模型认为原文已经够好、输出与原文一致时不写回，按钮直接回到「润色」。

## 为什么必须自己存原文

`InputActions.setDraft(text)` 的语义是「整体替换草稿」：

> Replace the whole draft (persisted-draft seed and programmatic writes).
> Placeholder-sanitized; newlines split paragraphs; caret lands at the end.
> **Merged into history so a seed is not an undoable step of its own.**

也就是说程序化写入不会在编辑器撤销栈里留下一个可撤销的编辑，Ctrl+Z 拿不回润色前的
文本。所以原文由组件自己（`savedRef`）持有，取消按钮就是「回退到这份快照」。

没有用 `captureInsertion()` + `insertText(text, span)`：那套契约是「在光标处插入一段
可撤销文本」，只能增不能减，做不到「整体替换」。整体替换只有 `setDraft`。

## 两半的分工

- **`index.js`（Host 半）**：注册 exact HTTP 端点 `POST /dsh-composer-polish/polish`。
  取当前会话默认模型（`ctx.get('agentDefaultModel').currentSelection()`），
  用 `ctx.get('llm').prepareCall({provider, model, ...})` 准备，再把 `prepared.config`
  原样展平回传进 `prepared.stream({...prepared.config, system, messages})` ——
  少传字段会抛 `INVALID_PREPARED_CALL`。返回 `{ok, intent, polished, original, provider, model}`。
  端点自带同源门禁（`Sec-Fetch-Site`，退化到 `Origin`/`Host` 比对）、64KB 请求体上限、
  JSON 校验、12000 字草稿上限。
- **`client.js`（浏览器半）**：`window.__ModuleLoader__.load` 形式的 slot occupant，
  标准 props 里的 `useInput(s => s.draft)` 读草稿、`inputActions.setDraft()` 写草稿，
  用 `fetch` 调上面的端点。

Host 端点没走 Connection RPC：本机 `dsh-liuyao` 的实测结论是插件自有前缀走 RPC 时
回调可能不触发，POST 会落到前端静态兜底返回 405；`webServer` 的 `kind:'exact'` 端点
总是优先于静态兜底。

## 文件

```text
dsh-composer-polish/
├── package.json        dsh.bundle.patch → cordis.patch.yml；dsh.client.platform = web
├── cordis.patch.yml    insert: id dsh-composer-polish
├── index.js            Host 半：模型调用 + exact 端点
├── client.js           浏览器半：按钮 + 润色/取消状态机
├── README.md
└── LICENSE             MIT
```

## 安装 / 重载

```powershell
# 方式一：从本地目录安装（plugin_manager 的 install_bundle，target 用绝对包目录）
#   target = <本仓库绝对路径>
# 方式二：发布到 npm 后，在 DSH 的插件市场里按包名安装
#   npm i dsh-composer-polish
```

装好即自动启用；profile 里是软链，改源码后重装可省。**新增 bundle 需要完全退出 DSH 再重开**才会加载。

- 改 **`index.js`**：宿主插件重载后立即生效（本插件已验证：端点直接 200）。
- 改 **`client.js`**：刷新页面（`Ctrl+R`）后生效；没跑 `pnpm run dev:web` 时不会热替换。

## 已验证

```text
POST http://127.0.0.1:57908/dsh-composer-polish/polish
{"draft":"帮我看下这个登录页面为啥一直500，日志里好像有null pointer"}

200 {"ok":true,
     "intent":"排查登录页面持续返回 500 错误（疑似空指针）的原因",
     "polished":"登录页面一直返回 500，日志里似乎有 NullPointerException。请帮我分析可能的原因并给出排查方向；如果需要更多信息（例如完整堆栈、相关代码、复现步骤），请列出你具体需要哪些内容。",
     "provider":"deepseek-official","model":"deepseek-flash","truncated":false}
```

`Slots.listSubTree('conversation.input.left')` 显示 occupant
`{registrant: 'dsh-composer-polish', id: 'prompt-polish', order: 10, active: true}`。
