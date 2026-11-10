/**
 * `dsh-session-relay` browser half.
 *
 * Two jobs:
 *
 * 1. **Peer message cards.** A cross-conversation message is durable the moment
 *    the host half delivers it, but the transcript renders every message whose
 *    `source.kind` is not `user` as a collapsed context-injection row. A peer
 *    message a human cannot read at a glance is a message they cannot follow, so
 *    this half promotes its own rows into cards whose sender is a link to the
 *    sending conversation. It identifies them by the producer label the Harness
 *    already renders for `source.kind === 'agent-message'`, then expands the row,
 *    hides the disclosure header, and restyles the body.
 *
 * 2. **Copy session id.** A header utility button that copies the current
 *    conversation id, so a human can hand it to another conversation or CLI.
 *
 * Both are presentation layers over shipped surfaces; when an upgrade changes
 * those markers the plugin degrades to the plain context row, never to an error.
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-relay',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		let react = null
		let jsxRuntime = null
		try {
			react = require('react')
			jsxRuntime = require('react/jsx-runtime')
		} catch {
			react = null
			jsxRuntime = null
		}

		/**
		 * Producer labels the Harness projects for our peer messages. The hub-era names
		 * stay in the set: messages already written to a session log carry them, and a
		 * rename must not make old relay cards unrecognisable.
		 */
		const SOURCE_LABELS = new Set(['agent-message', 'dsh-session-relay', 'session-relay', 'dsh-session-hub'])
		/** Marks a wrapper this half promoted into a card. */
		const CARD_ATTR = 'data-session-hub-card'
		/** Marks the sender element this half made clickable. */
		const LINK_CLASS = 'shub-sender-link'
		/** A live session id as the relay body renders it. */
		const SESSION_PATTERN = /session-[A-Za-z0-9][A-Za-z0-9-]{7,}/

		const CSS = [
			'[' + CARD_ATTR + '] > [data-disclosure-row] { display: none !important; }',
			'[' + CARD_ATTR + '] [data-context-form="relay"] {',
			'  width: fit-content; max-width: min(78%, 760px); max-height: none;',
			'  margin: 0; padding: 12px 16px; overflow: visible;',
			'  border: 1px solid rgba(127,127,127,.24);',
			'  border-radius: 16px 16px 16px 4px;',
			'  background: var(--dsw-alias-markdown-code-block);',
			'  color: var(--dsw-alias-label-primary); font: inherit;',
			'}',
			'[' + CARD_ATTR + '] [data-context-relay-sender] {',
			'  display: block; width: fit-content; margin: 0 0 8px;',
			'  color: var(--dsw-alias-state-business-primary);',
			'  font-size: 13px; font-weight: 600; line-height: 1.5;',
			'}',
			'.' + LINK_CLASS + ' { cursor: pointer; }',
			'.' + LINK_CLASS + ':hover { text-decoration: underline; text-underline-offset: 3px; }',
			'.' + LINK_CLASS + ':focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 2px; }',
			'.shub-header-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px;',
			'  height: 24px; padding: 0 8px; border: none; border-radius: 6px; background: 0 0;',
			'  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }',
			'.shub-header-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
		].join('\n')

		const NS = 'session-relay'
		const zh = {
			'copyId.label': '复制ID',
			'copyId.copied': '已复制',
			'copyId.title': '复制当前会话 ID',
			'sender.unknown': '对等会话',
		}
		const en = {
			'copyId.label': 'Copy ID',
			'copyId.copied': 'Copied',
			'copyId.title': 'Copy this conversation id',
			'sender.unknown': 'peer conversation',
		}

		/** Header button that copies the current conversation id. */
		function CopyIdButton(props) {
			const t = props.t
			const sessionId = String(props.sessionId ?? '')
			const [copied, setCopied] = react.useState(false)
			const copy = () => {
				if (sessionId.length === 0) return
				const clipboard = globalThis.navigator?.clipboard
				const done = () => {
					setCopied(true)
					setTimeout(() => setCopied(false), 1200)
				}
				if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
					clipboard.writeText(sessionId).then(done).catch(done)
				} else {
					done()
				}
			}
			return jsxRuntime.jsx('button', {
				type: 'button',
				className: 'shub-header-btn',
				title: t('copyId.title') + ' · ' + sessionId,
				onClick: copy,
				children: t(copied ? 'copyId.copied' : 'copyId.label'),
			})
		}

		/** Read the sending conversation id a relay body names. */
		function senderSessionId(body) {
			const sender = body.querySelector('[data-context-relay-sender]')
			const rendered = String(sender === null ? '' : sender.textContent ?? '').match(SESSION_PATTERN)
			if (rendered !== null) return rendered[0]
			const text = body.querySelector('[data-context-text]')
			const fromBody = String(text === null ? '' : text.textContent ?? '').match(SESSION_PATTERN)
			return fromBody === null ? null : fromBody[0]
		}

		/** The human-facing title of one conversation, falling back to its id. */
		function sessionTitle(ctx, sessionId) {
			try {
				const row = ctx.sessions?.list?.getSnapshot()?.byId?.[sessionId]
				const title = row === undefined ? undefined : row.displayTitle
				if (typeof title === 'string' && title.length > 0) return title
			} catch {
				/* title is decoration */
			}
			return sessionId
		}

		/** Every descendant of `root` matching `selector`, plus `root` itself. */
		function collect(root, selector) {
			const found = Array.from(root.querySelectorAll(selector))
			return root.matches(selector) ? [root].concat(found) : found
		}

		function apply(ctx) {
			const t = ctx.locale.bind(NS)
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-relay: dictionaries')

			/** Sender elements this half rewrote, so titles refresh in place. */
			const linked = new Set()
			/** Rows whose disclosure this half asked to open, awaiting their body. */
			const pending = new Set()

			function linkSender(body) {
				const element = body.querySelector('[data-context-relay-sender]')
				if (element === null) return
				const sessionId = senderSessionId(body)
				if (sessionId === null) return
				element.dataset.shubSession = sessionId
				element.textContent = sessionTitle(ctx, sessionId)
				element.classList.add(LINK_CLASS)
				element.setAttribute('role', 'link')
				element.setAttribute('tabindex', '0')
				element.setAttribute('title', sessionId)
				linked.add(element)
			}

			function adopt(wrapper) {
				const body = wrapper.querySelector('[data-context-form="relay"]')
				if (body === null) return false
				wrapper.setAttribute(CARD_ATTR, 'true')
				linkSender(body)
				return true
			}

			function prepare(root) {
				if (!(root instanceof Element)) return
				for (const label of collect(root, '[data-context-source]')) {
					if (!SOURCE_LABELS.has(String(label.textContent ?? '').trim())) continue
					const header = label.closest('[data-disclosure-row]')
					const wrapper = header === null ? null : header.parentElement
					if (wrapper === null) continue
					if (adopt(wrapper)) continue
					if (pending.has(wrapper)) continue
					pending.add(wrapper)
					if (header.getAttribute('aria-expanded') !== 'true') header.click()
				}
			}

			function drainPending() {
				for (const wrapper of [...pending]) {
					if (!wrapper.isConnected) {
						pending.delete(wrapper)
						continue
					}
					if (adopt(wrapper)) pending.delete(wrapper)
				}
			}

			function refreshTitles() {
				for (const element of linked) {
					if (!element.isConnected) {
						linked.delete(element)
						continue
					}
					const sessionId = element.dataset.shubSession
					if (sessionId !== undefined) element.textContent = sessionTitle(ctx, sessionId)
				}
			}

			function openSender(event) {
				const target = event.target instanceof Element ? event.target.closest('.' + LINK_CLASS) : null
				if (target === null) return
				const sessionId = target.dataset.shubSession
				if (sessionId === undefined) return
				event.preventDefault()
				try {
					ctx.sessions.open(sessionId)
				} catch {
					/* a stale id must not break the transcript */
				}
			}

			function onKeyDown(event) {
				if (event.key !== 'Enter' && event.key !== ' ') return
				openSender(event)
			}

			const style = document.createElement('style')
			style.setAttribute('data-plugin', 'dsh-session-relay')
			style.textContent = CSS
			document.head.appendChild(style)

			prepare(document.body)
			const observer = new MutationObserver((records) => {
				for (const record of records) record.addedNodes.forEach(prepare)
				drainPending()
			})
			observer.observe(document.body, { childList: true, subtree: true })

			let unsubscribe = () => {}
			try {
				unsubscribe = ctx.sessions.list.subscribe(refreshTitles)
			} catch {
				/* older shells expose no list store */
			}
			document.addEventListener('click', openSender)
			document.addEventListener('keydown', onKeyDown)

			ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
				name: 'conversation.session.header.utilities',
				id: 'session-relay-copy-id',
				order: 90,
				locale: NS,
				inject: (sessionId) => ({ sessionId, t }),
			}, CopyIdButton))

			ctx.effect(() => () => {
				observer.disconnect()
				unsubscribe()
				document.removeEventListener('click', openSender)
				document.removeEventListener('keydown', onKeyDown)
				linked.clear()
				pending.clear()
				style.remove()
			}, 'session-relay: cards')
		}

		exports.name = 'session-relay'
		exports.inject = ['sessions', 'slots', 'locale']
		exports.apply = apply
		return module.exports
	},
})
