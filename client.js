/**
 * dsh-composer-polish —— 浏览器半。
 *
 * 落位：`conversation.input.left`（composer 工具行里 `.modes` 容器之后的 list seat，
 * 也就是「权限」按钮（必要时还有「计划」按钮）右边）。
 *
 * 交互：
 *  idle   → 读草稿（InputState.draft）→ POST 给 Host 半 → 模型推断意图并润色
 *  done   → 按钮变「取消」，按下用 inputActions.setDraft(原文) 回退
 *  busy   → 请求在途，按钮禁用
 *  error  → 按钮变「重试」，title 显示失败原因
 *
 * 为什么自己存原文：InputActions.setDraft 的语义是「整体替换草稿」，编辑器侧的
 * undo 栈不会把一次程序化写入当成可撤销的编辑，控制-Z 拿不回润色前的文本，
 * 所以原文必须由本组件持有。
 */

window.__ModuleLoader__.load({
	id: 'dsh-composer-polish',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		var React = require('react')
		var h = React.createElement

		var PLUGIN_ID = 'dsh-composer-polish'
		var ENDPOINT = '/dsh-composer-polish/polish'
		var TIMEOUT_MS = 120000
		var SLOT_NAME = 'conversation.input.left'
		var CSS_ID = PLUGIN_ID + '/button'

		var CSS = [
			'.dpp-btn{',
			'display:inline-flex;align-items:center;justify-content:center;',
			'height:24px;padding:0 9px;margin-left:4px;',
			'border:1px solid rgba(128,128,128,.34);border-radius:999px;',
			'background:transparent;color:inherit;opacity:.86;',
			'font:inherit;font-size:12px;line-height:1;white-space:nowrap;',
			'cursor:pointer;user-select:none;',
			'transition:background .12s ease,border-color .12s ease,opacity .12s ease,color .12s ease;',
			'}',
			'.dpp-btn:hover:not(:disabled){background:rgba(128,128,128,.16);opacity:1}',
			'.dpp-btn:active:not(:disabled){background:rgba(128,128,128,.24)}',
			'.dpp-btn:focus-visible{outline:2px solid rgba(90,150,255,.7);outline-offset:1px}',
			'.dpp-btn:disabled{opacity:.42;cursor:default}',
			'.dpp-btn[data-phase="busy"]{border-color:rgba(90,150,255,.55);color:inherit;opacity:1}',
			'.dpp-btn[data-phase="busy"] .dpp-text::after{content:"";display:inline-block;width:1em;text-align:left;animation:dpp-dots 1.2s steps(1,end) infinite}',
			'@keyframes dpp-dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}100%{content:""}}',
			'.dpp-btn[data-phase="done"]{border-color:rgba(255,150,60,.8);background:rgba(255,150,60,.16);opacity:1}',
			'.dpp-btn[data-phase="done"]:hover{background:rgba(255,150,60,.28)}',
			'.dpp-btn[data-phase="error"]{border-color:rgba(235,90,90,.8);color:#e5484d;opacity:1}',
		].join('')

		function installStyles() {
			if (typeof document === 'undefined' || document.head === null) return function () {}
			var selector = 'style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']'
			var existing = document.querySelector(selector)
			if (existing !== null) return function () {}
			var tag = document.createElement('style')
			tag.setAttribute('data-plugin-css', CSS_ID)
			tag.textContent = CSS
			document.head.appendChild(tag)
			return function () {
				if (typeof tag.remove === 'function') tag.remove()
			}
		}

		/** 座位契约缺失时的静态占位：不崩、不抢位，只说明为什么点不了。 */
		function SeatUnavailable() {
			return h('button', {
				type: 'button',
				className: 'dpp-btn',
				'data-phase': 'idle',
				disabled: true,
				title: '润色按钮没有拿到 composer 的输入契约（useInput / inputActions）',
			}, h('span', { className: 'dpp-text' }, '润色'))
		}

		function PolishButton(props) {
			var useInput = props.useInput
			var actions = props.inputActions

			var selectDraft = React.useCallback(function (state) {
				return state !== null && typeof state === 'object' && typeof state.draft === 'string' ? state.draft : ''
			}, [])
			var draft = useInput(selectDraft)
			var text = typeof draft === 'string' ? draft : ''

			var phaseState = React.useState('idle')
			var phase = phaseState[0]
			var setPhase = phaseState[1]

			var errorState = React.useState('')
			var error = errorState[0]
			var setError = errorState[1]

			/** 润色前的原文（取消时回退的锚点）。 */
			var savedRef = React.useRef(null)
			/** 润色结果的文本，用来判断草稿是否被外部改过。 */
			var polishedRef = React.useRef(null)
			/** 程序化写入还没在编辑器里落地时的宽限标记（setDraft 走异步插入）。 */
			var applyingRef = React.useRef(false)
			/** 最新草稿与阶段：异步回调里读，避免闭包拿到过期值。 */
			var textRef = React.useRef(text)
			textRef.current = text
			var phaseRef = React.useRef(phase)
			phaseRef.current = phase

			// 处于「取消」态时，只要草稿不是我们写回去的那份（用户手改、发送清空、会话切换），
			// 回退锚点就失效了：退回 idle，绝不把旧原文硬塞回去。
			React.useEffect(function () {
				if (phaseRef.current !== 'done') return
				if (savedRef.current === null) return
				var current = text.trim()
				var applied = polishedRef.current === null ? null : polishedRef.current.trim()
				if (applied !== null && current === applied) {
					applyingRef.current = false
					return
				}
				// setDraft 是异步插入：还没落地就再等一次草稿变化，别把回退锚点提前丢掉。
				if (applyingRef.current) return
				savedRef.current = null
				polishedRef.current = null
				setPhase('idle')
			}, [text])

			var runPolish = React.useCallback(function (started) {
				var controller = typeof AbortController === 'function' ? new AbortController() : null
				var timer = controller !== null ? setTimeout(function () {
					try { controller.abort() } catch (ignored) {}
				}, TIMEOUT_MS) : null
				setPhase('busy')
				setError('')

				fetch(ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ draft: started }),
					...(controller !== null ? { signal: controller.signal } : {}),
				}).then(function (res) {
					return res.json().then(function (data) {
						return { res: res, data: data }
					}, function () {
						return { res: res, data: null }
					})
				}).then(function (out) {
					if (timer !== null) clearTimeout(timer)
					var data = out.data
					if (!out.res.ok || data === null || data.ok !== true || typeof data.polished !== 'string' || data.polished.trim() === '') {
						var reason = data !== null && typeof data.error === 'string' && data.error !== ''
							? data.error
							: '润色失败（HTTP ' + out.res.status + '）'
						throw new Error(reason)
					}
					// 请求期间使用者已经改了草稿：放弃写回，别覆盖新输入。
					if (textRef.current.trim() !== started.trim()) {
						setPhase('idle')
						return
					}
					var polished = data.polished
					if (textRef.current.trim() === polished.trim()) {
						// 模型认为原文已足够好：没有发生替换，也就没有可取消的东西。
						setPhase('idle')
						return
					}
					savedRef.current = started
					polishedRef.current = polished
					applyingRef.current = true
					actions.setDraft(polished)
					setPhase('done')
				}).catch(function (err) {
					if (timer !== null) clearTimeout(timer)
					if (err !== null && typeof err === 'object' && err.name === 'AbortError') {
						setPhase('error')
						setError('润色超时，点一下重试')
						return
					}
					setPhase('error')
					setError(err !== null && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err))
				})
			}, [actions])

			var onClick = React.useCallback(function () {
				var current = phaseRef.current
				if (current === 'busy') return
				if (current === 'done') {
					var original = savedRef.current
					savedRef.current = null
					polishedRef.current = null
					applyingRef.current = false
					setError('')
					setPhase('idle')
					if (original !== null && actions !== undefined && typeof actions.setDraft === 'function') actions.setDraft(original)
					return
				}
				var started = textRef.current
				if (started.trim() === '') return
				runPolish(started)
			}, [actions, runPolish])

			var label = '润色'
			var title = '推断你的意图，把这段草稿润色成一条高质量提示词'
			var disabled = false
			if (phase === 'busy') {
				label = '润色中'
				title = '正在让模型润色，稍候…'
				disabled = true
			} else if (phase === 'done') {
				label = '取消'
				title = '撤销润色，恢复润色前的提示词'
			} else if (phase === 'error') {
				label = '重试'
				title = error === '' ? '上次润色失败，点一下重试' : error
			} else if (text.trim() === '') {
				title = '输入框是空的：先写点东西再润色'
				disabled = true
			}

			return h('button', {
				type: 'button',
				className: 'dpp-btn',
				'data-phase': phase,
				'aria-label': phase === 'done' ? '取消润色并恢复原文' : '润色提示词',
				title: title,
				disabled: disabled,
				onMouseDown: function (event) {
					// 与 composer 自带按钮同一套做法：不抢输入框焦点。
					event.preventDefault()
				},
				onClick: onClick,
			}, h('span', { className: 'dpp-text' }, label))
		}

		/** 契约守卫：座位 props 缺输入能力时不进入任何 hook，直接给静态占位。 */
		function PolishSeat(props) {
			var hasInput = props !== null && typeof props === 'object'
				&& typeof props.useInput === 'function'
				&& props.inputActions !== null && typeof props.inputActions === 'object'
			if (!hasInput) return h(SeatUnavailable, null)
			return h(PolishButton, props)
		}

		var name = PLUGIN_ID
		var inject = ['slots']

		function apply(ctx) {
			var slots = ctx.get('slots')
			if (slots === undefined) return
			ctx.effect(installStyles, PLUGIN_ID + ': button styles')
			slots.inject(SLOT_NAME, function () {
				return slots.register({
					name: SLOT_NAME,
					id: 'prompt-polish',
					order: 10,
					label: '润色',
				}, PolishSeat)
			})
		}

		exports.name = name
		exports.inject = inject
		exports.apply = apply
		exports.PolishButton = PolishButton
		return module.exports
	},
})
