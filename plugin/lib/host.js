/**
 * dsh-session-relay — cross-conversation messaging, receipts, progress projection,
 * peer spawning and per-conversation rules, for DeepSeek Harness 0.2.x.
 *
 * Why this exists: Harness keeps every opened conversation in one process and
 * lets a plugin address any live Agent, but the only cross-session path it ships
 * is `parent → subagent`. Peers that are not each other's parent have no way to
 * talk, so pipelines fall back to writing hand-off files and polling them.
 *
 * This package adds the horizontal path. The delivered message uses Harness's
 * own V4 source kind for peer traffic (`kind: 'agent-message'`, `form: 'relay'`,
 * `senderSessionId`) — the same shape the shipped relay body already renders —
 * so it passes the V4 admission check that retired `kind: 'plugin'` fails
 * (see deepseek-harness discussion #9971) and the transcript can show who sent
 * it without inventing a node kind.
 *
 * Zero runtime dependencies: tools are plain definitions and every Harness
 * service is reached through `ctx.get`, so installing this package never has to
 * satisfy a `@deepseek-ai/*` peer.
 *
 * @module dsh-session-relay
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Stable Cordis plugin name. */
export const name = 'session-relay'

/** Required host services: the tool registry and the live Agent registry. */
export const inject = ['tools', 'agents']

const STATE_VERSION = 1
/** Oldest deliveries are dropped once this many are recorded. */
const MAX_DELIVERIES = 200
/** One message body is bounded so a hostile peer cannot flood a context window. */
const MAX_MESSAGE_CHARS = 30_000
/** `relay_read` never returns more than this many events. */
const MAX_READ_EVENTS = 50
/** A delivery younger than this is still plausibly queued. */
const PENDING_GRACE_MS = 15_000

const ADJECTIVES = [
	'amber', 'bright', 'calm', 'clever', 'cool', 'crisp', 'eager', 'fair', 'gentle', 'glad',
	'grand', 'happy', 'kind', 'lively', 'lucky', 'mellow', 'merry', 'mild', 'neat', 'nimble',
	'patient', 'plain', 'polite', 'proud', 'quiet', 'rapid', 'ready', 'safe', 'sharp', 'silly',
	'simple', 'smooth', 'solid', 'steady', 'sunny', 'swift', 'tidy', 'warm', 'wise', 'young',
]
const NOUNS = [
	'badger', 'beaver', 'crane', 'dolphin', 'eagle', 'falcon', 'finch', 'gecko', 'heron', 'ibis',
	'jaguar', 'koala', 'lemur', 'lynx', 'marmot', 'marten', 'moose', 'newt', 'ocelot', 'otter',
	'panda', 'pika', 'puffin', 'quail', 'raven', 'robin', 'seal', 'shark', 'sparrow', 'swan',
	'tiger', 'toucan', 'walrus', 'weasel', 'wolf', 'wombat', 'yak', 'zebra',
]

/** `$DSH_HOME/session-relay`, defaulting to `~/.dsh/session-relay`. */
function relayDirectory() {
	const home = (process.env.DSH_HOME ?? '').trim()
	return join(home.length > 0 ? home : join(homedir(), '.dsh'), 'session-relay')
}

/** Where 0.4.x (shipped as dsh-session-hub) kept its state. */
function legacyStatePath() {
	const home = (process.env.DSH_HOME ?? '').trim()
	return join(home.length > 0 ? home : join(homedir(), '.dsh'), 'session-hub', 'state.json')
}

function statePath() {
	return join(relayDirectory(), 'state.json')
}

/**
 * Rules written before 0.1.1 name tools `hub_*`. The tools are `relay_*` now, and a rule
 * pointing at a name nothing answers to would keep a guard silently disarmed, so the name
 * is migrated as the state is read.
 * @param rule a stored rule.
 * @returns the rule, with its tool name migrated when needed.
 */
function migrateRuleTools(rule) {
	if (rule === null || typeof rule !== 'object') return rule
	const tool = rule.tool
	if (typeof tool !== 'string' || tool.startsWith('hub_') === false) return rule
	return { ...rule, tool: `relay_${tool.slice('hub_'.length)}` }
}

/** Mint one handle no other conversation holds. */
function mintHandle(taken) {
	for (let attempt = 0; attempt < 64; attempt += 1) {
		const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
		const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
		const handle = `${adjective}-${noun}`
		if (!taken.has(handle)) return handle
	}
	return `peer-${randomUUID().slice(0, 8)}`
}

/** Durable handles, links and delivery receipts. */
class HubStore {
	constructor() {
		this.state = this.#load()
	}

	#load() {
		const empty = { version: STATE_VERSION, handles: {}, links: [], deliveries: [], rules: [] }
		let raw
		try {
			raw = readFileSync(statePath(), 'utf8')
		} catch {
			// 0.4.x shipped as dsh-session-hub. Read its state once so an upgrade keeps the
			// links, handles and rules it already recorded; the next #save lands on the new
			// path, so this fallback only ever applies to the first run after upgrading.
			try {
				raw = readFileSync(legacyStatePath(), 'utf8')
			} catch {
				return empty
			}
		}
		try {
			const parsed = JSON.parse(raw)
			if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) return empty
			return {
				version: STATE_VERSION,
				handles: parsed.handles !== null && typeof parsed.handles === 'object' ? parsed.handles : {},
				links: Array.isArray(parsed.links) ? parsed.links : [],
				deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
				rules: Array.isArray(parsed.rules) ? parsed.rules.map(migrateRuleTools) : [],
			}
		} catch {
			return empty
		}
	}

	#save() {
		const file = statePath()
		mkdirSync(dirname(file), { recursive: true })
		const temporary = `${file}.${randomUUID()}.tmp`
		writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
		renameSync(temporary, file)
	}

	/** Persist the current state (public entry for tools and guards). */
	save() {
		this.#save()
	}

	/** The stable handle of one conversation, minting it on first sight. */
	handleFor(sessionId) {
		const existing = this.state.handles[sessionId]
		if (typeof existing === 'string' && existing.length > 0) return existing
		const taken = new Set(Object.values(this.state.handles))
		const handle = mintHandle(taken)
		this.state.handles[sessionId] = handle
		this.#save()
		return handle
	}

	/** Resolve one handle to its conversation id. */
	byHandle(handle) {
		for (const [sessionId, candidate] of Object.entries(this.state.handles)) {
			if (candidate === handle) return sessionId
		}
		return undefined
	}

	/** The link `owner` made for `peer`, if any. */
	outbound(owner, peer) {
		return this.state.links.find((link) => link.owner === owner && link.peer === peer)
	}

	/** Links other conversations made to `owner` (the reply path needs no second link). */
	inbound(owner) {
		return this.state.links.filter((link) => link.peer === owner)
	}

	/** Store or refresh one link. */
	link(owner, peer, nickname, note) {
		const existing = this.outbound(owner, peer)
		if (existing !== undefined) {
			existing.name = nickname
			existing.note = note ?? existing.note
			existing.at = Date.now()
			this.#save()
			return existing
		}
		const created = { id: randomUUID(), owner, peer, name: nickname, note: note ?? '', at: Date.now() }
		this.state.links.push(created)
		this.#save()
		return created
	}

	/** Drop one link; the conversation itself keeps running. */
	unlink(owner, peer) {
		const before = this.state.links.length
		this.state.links = this.state.links.filter((link) => !(link.owner === owner && link.peer === peer))
		if (this.state.links.length !== before) this.#save()
		return before !== this.state.links.length
	}

	/** Record one accepted delivery so `relay_receipt` can answer later. */
	recordDelivery(entry) {
		this.state.deliveries.push(entry)
		if (this.state.deliveries.length > MAX_DELIVERIES) {
			this.state.deliveries.splice(0, this.state.deliveries.length - MAX_DELIVERIES)
		}
		this.#save()
	}

	/** One recorded delivery by message id. */
	deliveryOf(messageId) {
		return this.state.deliveries.find((entry) => entry.messageId === messageId)
	}
}

/** Compile the author-facing parameter map into the object schema the model sees. */
function compileParameters(spec) {
	const properties = {}
	const required = []
	for (const [key, node] of Object.entries(spec)) {
		const { required: isRequired, ...schema } = node
		properties[key] = schema
		if (isRequired === true) required.push(key)
	}
	return { type: 'object', additionalProperties: false, properties, ...(required.length === 0 ? {} : { required }) }
}

/** Build one tool definition from a parameter map, a result schema, and a runner. */
function defineHubTool(detail) {
	return {
		name: detail.name,
		description: detail.description,
		parameters: compileParameters(detail.parameters),
		output: {
			schema: detail.output,
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
		},
		execute: detail.run,
	}
}

/** One short line a human can read at a glance. */
function condense(text, limit) {
	const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
	return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`
}

/** Concatenate the text blocks of one message content array. */
function contentText(content) {
	if (!Array.isArray(content)) return ''
	return content
		.filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
		.map((block) => String(block.text ?? ''))
		.join('\n')
}

/** The calling conversation's own id. */
function callerIdOf(exec) {
	const id = exec?.agent?.id
	if (typeof id !== 'string' || id.length === 0) throw new Error('session-relay tools require an owning conversation')
	return id
}

/** The live Agent for one conversation, when this process holds it open. */
function liveAgentOf(ctx, sessionId) {
	try {
		return ctx.agents.get(sessionId)
	} catch {
		return undefined
	}
}

/** Visible conversations from the same source the sidebar uses. */
async function visibleSessions(ctx) {
	const controller = ctx.get('sessionController')
	if (controller !== undefined && typeof controller.list === 'function') {
		try {
			const value = await controller.list({}, undefined)
			if (Array.isArray(value?.items)) return value.items.map((item) => ({ ...item, live: item.running === true || liveAgentOf(ctx, String(item.sessionId)) !== undefined }))
		} catch {
			/* fall through to the registry-backed fallback */
		}
	}
	const query = ctx.get('sessionQuery')
	if (query !== undefined && typeof query.listSessions === 'function') {
		try {
			const records = await query.listSessions(undefined)
			return records.map((record) => ({
				sessionId: record.header.id,
				cwd: record.header.cwd,
				origin: record.header.origin,
				parentSessionId: record.header.parentSession,
				running: liveAgentOf(ctx, String(record.header.id))?.status === 'running',
				live: record.live === true,
				blank: false,
				formatStatus: record.formatStatus,
				agentAvailable: record.live === true,
				updatedAt: record.header.createdAt,
			}))
		} catch {
			return []
		}
	}
	return []
}

/** Archived conversation ids, whatever shape the registry keeps them in. */
function archivedIds(ctx) {
	const registry = ctx.get('workspaceRegistry')
	let value
	try {
		value = registry?.archivedSessionIds
		if (typeof value === 'function') value = value.call(registry)
	} catch {
		return new Set()
	}
	if (value instanceof Set) return value
	if (value instanceof Map) return new Set([...value.keys()].map(String))
	if (Array.isArray(value)) return new Set(value.map(String))
	if (value !== null && typeof value === 'object') return new Set(Object.keys(value))
	return new Set()
}

/** Conversations a peer may address: visible, non-blank, not a subagent, not archived. */
async function addressableSessions(ctx, includeBlank = false) {
	const archived = archivedIds(ctx)
	return (await visibleSessions(ctx)).filter((item) => {
		const id = String(item.sessionId)
		if (archived.has(id)) return false
		if (item.origin === 'subagent') return false
		if (includeBlank === false && item.blank === true) return false
		return true
	})
}

/** Batch-read titles, tolerating a missing title service. */
async function readTitles(ctx, sessionIds) {
	const titles = new Map()
	const query = ctx.get('sessionQuery')
	if (query === undefined || typeof query.readTitleSnapshots !== 'function' || sessionIds.length === 0) return titles
	try {
		const results = await query.readTitleSnapshots(sessionIds)
		for (const result of results) {
			if (result.status !== 'fulfilled') continue
			const title = result.value?.title?.title
			if (typeof title === 'string' && title.length > 0) titles.set(String(result.sessionId), title)
		}
	} catch {
		/* titles are decoration */
	}
	return titles
}

/**
 * Resolve one address (nickname, handle, or session id) to a conversation id.
 * Nicknames are per-link, so the caller's own links are consulted first.
 */
function resolveAddress(store, callerId, reference) {
	const raw = String(reference ?? '').trim()
	if (raw.length === 0) throw new Error('target must be a nickname, handle, or session id')
	if (raw.startsWith('session-')) return raw
	const named = store.state.links
		.filter((entry) => entry.name === raw && (entry.owner === callerId || entry.peer === callerId))
		.sort((left, right) => Number(right.at ?? 0) - Number(left.at ?? 0))
	if (named.length > 0) {
		const newest = named[0]
		return String(newest.peer === callerId ? newest.owner : newest.peer)
	}
	if (store.state.handles[raw] !== undefined) return raw
	const byHandle = store.byHandle(raw)
	if (byHandle !== undefined) return byHandle
	return raw
}

/**
 * Resolve one address with the title fallback: nickname, then handle, then session
 * id, and finally an EXACT conversation title — accepted only while it is unique,
 * because a duplicated title must never silently pick one of them.
 */
async function resolveTarget(ctx, store, callerId, reference, options = {}) {
	const raw = String(reference ?? '').trim()
	if (raw.length === 0) throw new Error('target must be a nickname, handle, session id, or a unique title')
	const quick = resolveAddress(store, callerId, raw)
	if (quick !== raw || raw.startsWith('session-')) return quick
	const sessions = await addressableSessions(ctx, options.allowBlank === true)
	const titles = await readTitles(ctx, sessions.map((item) => String(item.sessionId)))
	const needle = raw.toLowerCase()
	const matches = sessions.filter((item) => String(titles.get(String(item.sessionId)) ?? '').trim().toLowerCase() === needle)
	if (matches.length === 1) return String(matches[0].sessionId)
	if (matches.length > 1) {
		const candidates = matches.map((item) => `${store.handleFor(String(item.sessionId))} (${item.sessionId})`).join(', ')
		throw new Error(`title "${raw}" matches ${matches.length} conversations; address one by handle or session id: ${candidates}`)
	}
	return raw
}

/** Read one conversation's events: live when possible, cold reads otherwise. */
async function eventsOf(ctx, sessionId) {
	const agent = liveAgentOf(ctx, sessionId)
	if (agent !== undefined && typeof agent.session?.ownEvents === 'function') {
		try {
			return agent.session.ownEvents()
		} catch {
			/* fall through to the controller */
		}
	}
	const controller = ctx.get('sessionController')
	if (controller !== undefined && typeof controller.inspect === 'function') {
		try {
			const inspection = await controller.inspect(sessionId, undefined)
			if (Array.isArray(inspection?.events)) return inspection.events
		} catch {
			return undefined
		}
	}
	const query = ctx.get('sessionQuery')
	if (query !== undefined && typeof query.readSession === 'function') {
		try {
			const snapshot = await query.readSession(sessionId)
			return snapshot?.events
		} catch {
			return undefined
		}
	}
	return undefined
}

/** Project one conversation's progress without waking it. */
async function projectStatus(ctx, sessionId, recent = 3) {
	const events = await eventsOf(ctx, sessionId)
	const agent = liveAgentOf(ctx, sessionId)
	if (events === undefined && agent === undefined) return undefined
	let turn = 0
	let step = 0
	let lastUser = ''
	let lastAssistant = ''
	const toolNames = []
	const messages = []
	for (const event of events ?? []) {
		switch (event.type) {
			case 'turn/start':
				turn = Number(event.data?.turn ?? turn)
				break
			case 'step/start':
				step = Number(event.data?.step ?? step)
				break
			case 'user/message': {
				const text = condense(contentText(event.data?.content), 240)
				if (text.length > 0) {
					lastUser = text
					messages.push({ role: 'user', text })
				}
				break
			}
			case 'assistant/message': {
				const text = condense(contentText(event.data?.message?.content), 240)
				if (text.length > 0) {
					lastAssistant = text
					messages.push({ role: 'assistant', text })
				}
				break
			}
			case 'tool/call':
				toolNames.push(String(event.data?.name ?? 'tool'))
				break
			default:
				break
		}
	}
	return {
		sessionId,
		live: agent !== undefined,
		status: agent === undefined ? 'inactive' : agent.status === 'running' ? 'running' : 'idle',
		cwd: String(agent?.session?.header?.cwd ?? ''),
		turn,
		step,
		lastUserText: lastUser,
		lastAssistantText: lastAssistant,
		recentToolNames: toolNames.slice(-8),
		recentMessages: messages.slice(-Math.max(1, Math.min(recent, 10))),
	}
}

/** The inbox depth of one live Agent, or 0. */
function pendingCount(agent) {
	if (agent === undefined) return 0
	try {
		const inbox = agent.inbox
		return Number(inbox.nextTurn.length) + Number(inbox.nextStep.length)
	} catch {
		return 0
	}
}

/** Frame the model-facing text of one peer message. */
function frameMessage(detail) {
	const lines = [`[peer message from ${detail.senderName ?? detail.senderHandle} (${detail.senderHandle})]`]
	if (detail.recipientHandle !== undefined) lines.push(`[your handle is ${detail.recipientHandle}]`)
	lines.push('')
	lines.push(detail.body)
	lines.push('')
	lines.push(`[Reply when a reply is needed: relay_reply to="${detail.senderHandle}"]`)
	return lines.join('\n')
}

/** One durable peer message in the shape Harness's V4 admission accepts. */
function peerMessage(detail) {
	return Object.freeze({
		id: randomUUID(),
		role: 'user',
		content: Object.freeze([{ type: 'text', text: frameMessage(detail) }]),
		source: Object.freeze({
			kind: 'agent-message',
			form: 'relay',
			senderSessionId: detail.senderId,
		}),
	})
}

/** Delivery mode resolution: an idle target gets a clean turn, a running one a step boundary. */
function resolveMode(status, requested, fallback = 'auto') {
	const choice = requested === undefined ? fallback : requested
	if (choice === 'queue' || choice === 'steer' || choice === 'inject') return choice
	return status === 'running' ? 'steer' : 'queue'
}

/** Hand one message to a live Agent through the inbox boundary the mode names. */
function deliverToAgent(agent, message, mode) {
	if (mode === 'steer') agent.steer(message)
	else if (mode === 'inject') agent.inject(message)
	else agent.followup(message)
}

/** Obtain a live Agent for one conversation, resuming a cold one. */
async function ensureAgent(ctx, sessionId) {
	const live = liveAgentOf(ctx, sessionId)
	if (live !== undefined) return live
	const controller = ctx.get('sessionController')
	if (controller !== undefined && typeof controller.resolveAgent === 'function') {
		const result = await controller.resolveAgent(sessionId)
		if (result?.agent !== undefined) return result.agent
	}
	try {
		const resumed = await ctx.agents.resume({ resumeSessionId: sessionId })
		return resumed?.agent ?? resumed
	} catch {
		return undefined
	}
}

/** Serialize a value for rule matching without letting a hostile value trap the rule. */
function serializeForMatch(value) {
	try {
		const text = JSON.stringify(value ?? {})
		return typeof text === 'string' ? text.slice(0, 16_384) : ''
	} catch {
		return ''
	}
}

/** Whether one rule's argument substring applies to the given serialized text. */
function ruleTextMatches(rule, text) {
	return String(rule.match ?? '').length === 0 || String(text ?? '').includes(String(rule.match))
}

/** The first rule that names this tool, this call, and (for after rules) this result. */
function selectCallRule(rules, toolName, argumentsText, resultText) {
	return rules.find((rule) => {
		const tool = String(rule.tool ?? '*')
		if (tool !== '*' && tool !== toolName) return false
		if (ruleTextMatches(rule, argumentsText) === false) return false
		const resultMatch = String(rule.resultMatch ?? '')
		if (resultMatch.length === 0) return true
		return String(resultText ?? '').includes(resultMatch)
	})
}

/** One context message that restates a standing constraint to its own conversation. */
function ruleMessage(ownerId, rule) {
	return Object.freeze({
		id: randomUUID(),
		role: 'user',
		content: Object.freeze([{
			type: 'text',
			text: `[standing rule ${rule.id} declared in this conversation]\n\n${rule.text}`,
		}]),
		source: Object.freeze({ kind: 'agent-message', form: 'notice', senderSessionId: ownerId }),
	})
}

/** Resolve the workspace that owns one directory, when the registry knows it. */
async function workspaceForPath(ctx, directory) {
	const registry = ctx.get('workspaceRegistry')
	if (registry === undefined || directory.length === 0) return undefined
	try {
		if (typeof registry.resolveByPath === 'function') {
			const resolved = await registry.resolveByPath(directory)
			if (resolved !== undefined) return resolved
		}
		const list = typeof registry.list === 'function' ? registry.list() : []
		return list.find((workspace) => String(workspace.path ?? '') === directory)
	} catch {
		return undefined
	}
}

/** Map every accounted session id to its workspace title. */
function workspaceTitles(ctx) {
	const map = new Map()
	const registry = ctx.get('workspaceRegistry')
	let list = []
	try {
		list = typeof registry?.list === 'function' ? registry.list() : []
	} catch {
		list = []
	}
	for (const workspace of list) {
		for (const id of workspace.sessionIds ?? []) map.set(String(id), String(workspace.title ?? workspace.id ?? ''))
	}
	return map
}

/** The workspace a new conversation joins when the caller named no directory. */
function defaultWorkspace(ctx) {
	const registry = ctx.get('workspaceRegistry')
	let list = []
	try {
		list = typeof registry?.list === 'function' ? registry.list() : []
	} catch {
		return undefined
	}
	return list.find((workspace) => String(workspace.id) === 'default')
		?? list.find((workspace) => String(workspace.path ?? '').toLowerCase().endsWith('default-workspace'))
		?? list[0]
}

/** Subscribe every tool. */
export function apply(ctx, config) {
	const store = new HubStore()
	const options = {
		autoLink: config?.autoLink !== false,
		messageForm: config?.messageForm === 'notice' ? 'notice' : 'relay',
		defaultMode: ['auto', 'queue', 'steer', 'inject'].includes(config?.defaultMode) ? config.defaultMode : 'queue',
	}
	const tools = createTools(ctx, store, options)
	for (const tool of tools) ctx.tools.register(tool)
	registerGuards(ctx, store)
	ctx.logger?.info?.(`session-relay: ${tools.length} tools registered (state: ${statePath()})`)
}

/** Build every tool definition this plugin registers. */
function createTools(ctx, store, options) {
	/** Deliver one message and record its receipt entry. */
	async function sendOne(exec, input, deliveryOptions = {}) {
		const callerId = callerIdOf(exec)
		const peerId = await resolveTarget(ctx, store, callerId, input.target, { allowBlank: deliveryOptions.allowBlank === true })
		if (peerId === callerId) throw new Error('a conversation cannot message itself')
		const addressable = await addressableSessions(ctx, deliveryOptions.allowBlank === true)
		const target = addressable.find((item) => String(item.sessionId) === peerId)
		if (target === undefined) {
			throw new Error(`conversation "${input.target}" is not one this workspace shows: it is archived, still blank, or a subagent`)
		}
		const agent = await ensureAgent(ctx, peerId)
		if (agent === undefined) throw new Error(`conversation "${input.target}" has no Agent available to receive a message`)
		const status = agent.status === 'running' ? 'running' : 'idle'
		const mode = resolveMode(status, input.mode, options.defaultMode)
		const body = String(input.message ?? '')
		if (body.trim().length === 0) throw new Error('message must not be empty')
		if (body.length > MAX_MESSAGE_CHARS) throw new Error(`message exceeds ${MAX_MESSAGE_CHARS} characters`)
		const peerTitles = await readTitles(ctx, [peerId])
		const peerTitle = String(peerTitles.get(peerId) ?? '')
		const senderHandle = store.handleFor(callerId)
		const recipientHandle = store.handleFor(peerId)
		const message = peerMessage({
			senderId: callerId,
			senderHandle,
			senderName: input.senderName,
			recipientHandle,
			body,
		})
		const linkedExisting = store.outbound(callerId, peerId)
		if (linkedExisting === undefined && options.autoLink !== true) {
			throw new Error(`conversation "${input.target}" is not linked yet; call relay_link first (autoLink is disabled)`)
		}
		deliverToAgent(agent, message, mode)
		let linked = false
		if (linkedExisting === undefined) {
			store.link(callerId, peerId, input.name ?? (peerTitle.length > 0 ? peerTitle : recipientHandle))
			linked = true
		}
		store.recordDelivery({
			messageId: message.id,
			from: callerId,
			to: peerId,
			at: Date.now(),
			mode,
			receipt: 'accepted',
		})
		return {
			messageId: message.id,
			target: { sessionId: peerId, handle: recipientHandle, title: peerTitle },
			mode,
			receipt: 'accepted',
			linked,
			targetStatus: status,
		}
	}

	return [
		defineHubTool({
			name: 'relay_list',
			description: 'List the conversations you can message, with their stable handles: exactly the conversations this '
				+ 'workspace shows the human (archived, blank and subagent ones are excluded). Closed conversations are listed '
				+ 'too — messaging one resumes it.',
			parameters: {
				scope: {
					type: 'string',
					enum: ['workspace', 'all'],
					description: 'workspace (default) lists this working directory; all lists every addressable conversation.',
				},
				includeSelf: { type: 'boolean', description: 'Include your own conversation in the list (default false).' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['self', 'selfHandle', 'conversations'],
				properties: {
					self: { type: 'string' },
					selfHandle: { type: 'string' },
					conversations: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['handle', 'sessionId', 'title', 'status', 'cwd', 'linked'],
							properties: {
								handle: { type: 'string' },
								sessionId: { type: 'string' },
								title: { type: 'string' },
								status: { type: 'string' },
								cwd: { type: 'string' },
								workspace: { type: 'string', description: 'Workspace title this conversation is grouped under, or empty when it is ungrouped.' },
								linked: { type: 'boolean' },
								nickname: { type: 'string' },
							},
						},
					},
				},
			},
			run: async (_args, exec) => {
				const callerId = callerIdOf(exec)
				const all = await addressableSessions(ctx)
				const titles = await readTitles(ctx, all.map((item) => String(item.sessionId)))
				const callerCwd = String(liveAgentOf(ctx, callerId)?.session?.header?.cwd ?? '')
				const scoped = _args.scope === 'all' || callerCwd.length === 0
					? all
					: all.filter((item) => String(item.cwd ?? '') === callerCwd || item.sessionId === callerId)
				const workspaceOf = workspaceTitles(ctx)
				const rows = scoped
					.filter((item) => _args.includeSelf === true || String(item.sessionId) !== callerId)
					.map((item) => {
						const sessionId = String(item.sessionId)
						const link = store.outbound(callerId, sessionId)
						const agent = liveAgentOf(ctx, sessionId)
						return {
							handle: store.handleFor(sessionId),
							sessionId,
							title: String(titles.get(sessionId) ?? ''),
							status: agent === undefined ? (item.running === true ? 'running' : 'inactive') : agent.status === 'running' ? 'running' : 'idle',
							cwd: String(item.cwd ?? ''),
							workspace: workspaceOf.get(sessionId) ?? '',
							linked: link !== undefined,
							...(link === undefined ? {} : { nickname: String(link.name) }),
						}
					})
				return { self: callerId, selfHandle: store.handleFor(callerId), conversations: rows }
			},
		}),
		defineHubTool({
			name: 'relay_whoami',
			description: 'Return your own conversation id and stable handle, plus the handle others should use to reach you.',
			parameters: {},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'handle', 'cwd'],
				properties: {
					sessionId: { type: 'string' },
					handle: { type: 'string' },
					cwd: { type: 'string' },
					title: { type: 'string' },
				},
			},
			run: async (_args, exec) => {
				const callerId = callerIdOf(exec)
				const titles = await readTitles(ctx, [callerId])
				return {
					sessionId: callerId,
					handle: store.handleFor(callerId),
					cwd: String(liveAgentOf(ctx, callerId)?.session?.header?.cwd ?? ''),
					title: String(titles.get(callerId) ?? ''),
				}
			},
		}),
		defineHubTool({
			name: 'relay_link',
			description: 'Give another conversation a durable nickname and record the relationship (who named whom, and when). '
				+ 'Links survive restarts and are what makes a peer a first-class address instead of a raw id.',
			parameters: {
				target: { type: 'string', required: true, description: 'Handle, session id, or existing nickname.' },
				name: { type: 'string', required: true, description: 'Nickname you will use for that conversation.' },
				note: { type: 'string', description: 'Optional note about what that conversation is for.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['linked', 'target', 'name'],
				properties: {
					linked: { type: 'boolean' },
					target: { type: 'string' },
					handle: { type: 'string' },
					name: { type: 'string' },
					at: { type: 'integer' },
				},
			},
			run: async (args, exec) => {
				const callerId = callerIdOf(exec)
				const peerId = await resolveTarget(ctx, store, callerId, args.target)
				if (peerId === callerId) throw new Error('a conversation cannot link itself')
				const addressable = await addressableSessions(ctx)
				if (!addressable.some((item) => String(item.sessionId) === peerId)) {
					throw new Error(`conversation "${args.target}" is not one this workspace shows: it is archived, still blank, or a subagent`)
				}
				const link = store.link(callerId, peerId, String(args.name), typeof args.note === 'string' ? args.note : '')
				return { linked: true, target: peerId, handle: store.handleFor(peerId), name: String(link.name), at: Number(link.at) }
			},
		}),
		defineHubTool({
			name: 'relay_unlink',
			description: 'Drop the nickname for one conversation. The conversation keeps running; only the name goes away.',
			parameters: {
				target: { type: 'string', required: true, description: 'Handle, session id, or nickname.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['unlinked', 'target'],
				properties: { unlinked: { type: 'boolean' }, target: { type: 'string' } },
			},
			run: async (args, exec) => {
				const callerId = callerIdOf(exec)
				const peerId = await resolveTarget(ctx, store, callerId, args.target)
				return { unlinked: store.unlink(callerId, peerId), target: peerId }
			},
		}),
		defineHubTool({
			name: 'relay_send',
			description: 'Send one message to another conversation. Unlinked targets are linked on first contact. A closed '
				+ 'target is resumed and woken; a running target can be steered at its next step boundary. The message is '
				+ 'delivered as a Harness peer message (agent-message relay), never as a user message.',
			parameters: {
				target: { type: 'string', required: true, description: 'Nickname, handle, session id, or a unique conversation title.' },
				message: { type: 'string', required: true, description: 'Body to deliver verbatim.' },
				mode: {
					type: 'string',
					enum: ['auto', 'queue', 'steer', 'inject'],
					description: 'auto (default) steers a running target and queues for an idle one; queue starts a fresh turn; '
						+ 'steer joins the next step; inject adds context without waking.',
				},
				name: { type: 'string', description: 'Nickname to record on first contact (defaults to the target handle).' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['messageId', 'mode', 'receipt', 'target', 'targetStatus'],
				properties: {
					messageId: { type: 'string' },
					mode: { type: 'string' },
					receipt: { type: 'string' },
					linked: { type: 'boolean' },
					targetStatus: { type: 'string' },
					target: {
						type: 'object',
						additionalProperties: false,
						required: ['sessionId', 'handle'],
						properties: { sessionId: { type: 'string' }, handle: { type: 'string' }, title: { type: 'string' } },
					},
				},
			},
			run: async (args, exec) => sendOne(exec, {
				target: args.target,
				message: args.message,
				mode: args.mode === 'auto' ? undefined : args.mode,
				name: args.name,
			}),
		}),
		defineHubTool({
			name: 'relay_reply',
			description: 'Reply to the conversation that messaged you. Same delivery rules as relay_send, but the target is the '
				+ 'sender you were given rather than a nickname you own.',
			parameters: {
				to: { type: 'string', required: true, description: 'Handle, nickname, or session id of the sender.' },
				text: { type: 'string', required: true, description: 'Reply body.' },
				mode: { type: 'string', enum: ['auto', 'queue', 'steer', 'inject'], description: 'Delivery mode.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['messageId', 'mode', 'receipt', 'target', 'targetStatus'],
				properties: {
					messageId: { type: 'string' },
					mode: { type: 'string' },
					receipt: { type: 'string' },
					linked: { type: 'boolean' },
					targetStatus: { type: 'string' },
					target: {
						type: 'object',
						additionalProperties: false,
						required: ['sessionId', 'handle'],
						properties: { sessionId: { type: 'string' }, handle: { type: 'string' }, title: { type: 'string' } },
					},
				},
			},
			run: async (args, exec) => sendOne(exec, {
				target: args.to,
				message: args.text,
				mode: args.mode === 'auto' ? undefined : args.mode,
			}),
		}),
		defineHubTool({
			name: 'relay_broadcast',
			description: 'Send one message to several conversations at once (up to 20). Each target reports its own success '
				+ 'or failure, so one bad address never hides the rest.',
			parameters: {
				targets: {
					type: 'array',
					required: true,
					items: { type: 'string' },
					description: 'Handles, nicknames, or session ids (1–20 entries).',
				},
				message: { type: 'string', required: true, description: 'Body delivered to every target.' },
				mode: { type: 'string', enum: ['auto', 'queue', 'steer', 'inject'], description: 'Delivery mode for every target.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['results'],
				properties: {
					results: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['target', 'ok'],
							properties: {
								target: { type: 'string' },
								ok: { type: 'boolean' },
								sessionId: { type: 'string' },
								messageId: { type: 'string' },
								mode: { type: 'string' },
								error: { type: 'string' },
							},
						},
					},
				},
			},
			run: async (args, exec) => {
				const list = Array.isArray(args.targets) ? args.targets.map(String).filter((item) => item.trim().length > 0) : []
				if (list.length === 0) throw new Error('targets must contain at least one address')
				if (list.length > 20) throw new Error('broadcast accepts at most 20 targets')
				const results = []
				for (const target of list) {
					try {
						const sent = await sendOne(exec, {
							target,
							message: args.message,
							mode: args.mode === 'auto' ? undefined : args.mode,
						})
						results.push({ target, ok: true, sessionId: sent.target.sessionId, messageId: sent.messageId, mode: sent.mode })
					} catch (error) {
						results.push({ target, ok: false, error: error instanceof Error ? error.message : String(error) })
					}
				}
				return { results }
			},
		}),
		defineHubTool({
			name: 'relay_receipt',
			description: 'Check what happened to one message you sent: pending (still queued), claimed (it reached the target '
				+ 'conversation log), discarded, or unknown.',
			parameters: {
				messageId: { type: 'string', required: true, description: 'The messageId relay_send / relay_reply returned.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['messageId', 'receipt'],
				properties: {
					messageId: { type: 'string' },
					receipt: { type: 'string' },
					target: { type: 'string' },
					targetTitle: { type: 'string' },
					targetStatus: { type: 'string' },
					mode: { type: 'string' },
					at: { type: 'integer' },
				},
			},
			run: async (args) => {
				const delivery = store.deliveryOf(String(args.messageId))
				if (delivery === undefined) return { messageId: String(args.messageId), receipt: 'unknown' }
				const events = await eventsOf(ctx, String(delivery.to))
				let receipt = 'unknown'
				if (events !== undefined) {
					const claimed = events.some((event) => event?.type === 'user/message' && String(event?.data?.id ?? '') === String(delivery.messageId))
					if (claimed) receipt = 'claimed'
					else if (Date.now() - Number(delivery.at) < PENDING_GRACE_MS) receipt = 'pending'
					else {
						const discarded = events.some((event) => String(event?.type ?? '').includes('discard') && JSON.stringify(event?.data ?? {}).includes(String(delivery.messageId)))
						receipt = discarded ? 'discarded' : 'unknown'
					}
				} else if (Date.now() - Number(delivery.at) < PENDING_GRACE_MS) {
					receipt = 'pending'
				}
				const agent = liveAgentOf(ctx, String(delivery.to))
				const deliveryTitles = await readTitles(ctx, [String(delivery.to)])
				return {
					messageId: String(args.messageId),
					receipt,
					targetTitle: String(deliveryTitles.get(String(delivery.to)) ?? ''),
					target: String(delivery.to),
					targetStatus: agent === undefined ? 'inactive' : agent.status === 'running' ? 'running' : 'idle',
					mode: String(delivery.mode ?? ''),
					at: Number(delivery.at),
				}
			},
		}),
		defineHubTool({
			name: 'relay_status',
			description: 'Project another conversation\'s progress without disturbing it: turn/step, last user and assistant '
				+ 'text, recent tool names, inbox depth, and whether it is running.',
			parameters: {
				target: { type: 'string', required: true, description: 'Nickname, handle, session id, or a unique conversation title.' },
				recent: { type: 'integer', description: 'How many recent messages to include (1–10, default 3).' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'status', 'turn', 'step', 'pending', 'recentToolNames'],
				properties: {
					sessionId: { type: 'string' },
					handle: { type: 'string' },
					title: { type: 'string' },
					status: { type: 'string' },
					live: { type: 'boolean' },
					cwd: { type: 'string' },
					turn: { type: 'integer' },
					step: { type: 'integer' },
					pending: { type: 'integer' },
					lastUserText: { type: 'string' },
					lastAssistantText: { type: 'string' },
					recentToolNames: { type: 'array', items: { type: 'string' } },
					recentMessages: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['role', 'text'],
							properties: { role: { type: 'string' }, text: { type: 'string' } },
						},
					},
				},
			},
			run: async (args, exec) => {
				const callerId = callerIdOf(exec)
				const peerId = await resolveTarget(ctx, store, callerId, args.target)
				const status = await projectStatus(ctx, peerId, Number.isInteger(args.recent) ? args.recent : 3)
				if (status === undefined) throw new Error(`conversation "${args.target}" cannot be read`)
				const statusTitles = await readTitles(ctx, [peerId])
				return {
					...status,
					handle: store.handleFor(peerId),
					title: String(statusTitles.get(peerId) ?? ''),
					pending: pendingCount(liveAgentOf(ctx, peerId)),
				}
			},
		}),
		defineHubTool({
			name: 'relay_read',
			description: 'Read the tail of another conversation\'s event log without waking it (type, sequence, time and a '
				+ 'short preview per event).',
			parameters: {
				target: { type: 'string', required: true, description: 'Nickname, handle, session id, or a unique conversation title.' },
				tail: { type: 'integer', description: 'How many events to return (1–50, default 10).' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'events'],
				properties: {
					sessionId: { type: 'string' },
					handle: { type: 'string' },
					title: { type: 'string' },
					events: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['seq', 'type', 'time', 'preview'],
							properties: {
								seq: { type: 'integer' },
								type: { type: 'string' },
								time: { type: 'integer' },
								preview: { type: 'string' },
							},
						},
					},
				},
			},
			run: async (args, exec) => {
				const callerId = callerIdOf(exec)
				const peerId = await resolveTarget(ctx, store, callerId, args.target)
				const events = await eventsOf(ctx, peerId)
				if (events === undefined) throw new Error(`conversation "${args.target}" cannot be read`)
				const tail = Number.isInteger(args.tail) ? Math.max(1, Math.min(args.tail, MAX_READ_EVENTS)) : 10
				const rows = events.slice(-tail).map((event) => {
					const text = event.type === 'user/message' || event.type === 'assistant/message'
						? contentText(event.type === 'user/message' ? event.data?.content : event.data?.message?.content)
						: event.type === 'tool/call'
							? `${String(event.data?.name ?? '')} ${String(event.data?.arguments ?? '')}`
							: JSON.stringify(event.data ?? {})
					return {
						seq: Number(event.seq ?? 0),
						type: String(event.type ?? ''),
						time: Number(event.time ?? 0),
						preview: condense(text, 200),
					}
				})
				const readTitlesById = await readTitles(ctx, [peerId])
				return { sessionId: peerId, handle: store.handleFor(peerId), title: String(readTitlesById.get(peerId) ?? ''), events: rows }
			},
		}),
		defineHubTool({
			name: 'relay_spawn',
			description: 'Open a NEW peer conversation beside this one — a plain top-level conversation, not a subagent — '
				+ 'optionally linked under a nickname and handed a first task. The new conversation appears in the sidebar '
				+ 'like any other.',
			parameters: {
				name: { type: 'string', required: true, description: 'Nickname to give the new conversation (also its handle alias).' },
				task: { type: 'string', description: 'Optional first task delivered as a peer message right away.' },
				cwd: { type: 'string', description: 'Working directory for the new conversation (defaults to this one).' },
				agentPreset: { type: 'string', description: 'Optional agent preset id to inherit instead of the default.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'handle', 'name', 'attached'],
				properties: {
					sessionId: { type: 'string' },
					handle: { type: 'string' },
					name: { type: 'string' },
					messageId: { type: 'string' },
					workspaceId: { type: 'string' },
					workspaceTitle: { type: 'string' },
					attached: { type: 'boolean', description: 'Whether the new conversation joined a workspace.' },
				},
			},
			run: async (args, exec) => {
				const callerId = callerIdOf(exec)
				const controller = ctx.get('sessionController')
				if (controller === undefined || typeof controller.create !== 'function') {
					throw new Error('sessionController.create is unavailable, so a peer conversation cannot be created here')
				}
				const requestedCwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
				const inheritedCwd = String(liveAgentOf(ctx, callerId)?.session?.header?.cwd ?? '')
				const fallbackWorkspace = defaultWorkspace(ctx)
				const cwd = requestedCwd.length > 0
					? requestedCwd
					: inheritedCwd.length > 0 ? inheritedCwd : String(fallbackWorkspace?.path ?? '')
				const nickname = String(args.name)
				if (store.state.links.some((entry) => entry.owner === callerId && entry.name === nickname)) {
					throw new Error(`nickname "${nickname}" is already used by another conversation; choose another name`)
				}
				const workspace = await workspaceForPath(ctx, cwd)
				// session.create takes EITHER a workspace or a bare cwd, never both.
				const created = await controller.create({
					...(workspace === undefined ? (cwd.length > 0 ? { cwd } : {}) : { workspaceId: workspace.id }),
					...(typeof args.agentPreset === 'string' && args.agentPreset.length > 0 ? { agentPreset: args.agentPreset } : {}),
				})
				const sessionId = String(created.sessionId)
				let attached = workspace !== undefined
					&& Array.isArray(workspace.sessionIds)
					&& workspace.sessionIds.includes(sessionId)
				if (attached === false && workspace !== undefined && typeof workspace.attachSession === 'function') {
					try {
						await workspace.attachSession(sessionId)
						attached = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)
					} catch {
						attached = false
					}
				}
				const handle = store.handleFor(sessionId)
				store.link(callerId, sessionId, nickname)
				// The nickname is an address; a human also needs the sidebar row to
				// carry it, so the new conversation is renamed to that same name.
				let title = nickname
				if (typeof controller.rename === 'function') {
					try {
						const renamed = await controller.rename({ sessionId, title: nickname })
						if (typeof renamed?.title === 'string' && renamed.title.length > 0) title = renamed.title
					} catch {
						/* the conversation exists even when the rename is refused */
					}
				}
				let messageId
				if (typeof args.task === 'string' && args.task.trim().length > 0) {
					const sent = await sendOne(exec, { target: sessionId, message: args.task, mode: 'queue' }, { allowBlank: true })
					messageId = sent.messageId
				}
				return {
					sessionId,
					handle,
					name: nickname,
					attached,
					...(messageId === undefined ? {} : { messageId }),
					...(workspace === undefined ? {} : { workspaceId: String(workspace.id), workspaceTitle: String(workspace.title ?? '') }),
				}
			},
		}),
		defineHubTool({
			name: 'relay_rename',
			description: 'Rename another conversation.',
			parameters: {
				target: { type: 'string', required: true, description: 'Nickname, handle, session id, or a unique conversation title.' },
				title: { type: 'string', required: true, description: 'New title (1–120 characters).' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'title'],
				properties: { sessionId: { type: 'string' }, title: { type: 'string' }, seq: { type: 'integer' } },
			},
			run: async (args, exec) => {
				const callerId = callerIdOf(exec)
				const peerId = await resolveTarget(ctx, store, callerId, args.target)
				const title = String(args.title ?? '').trim()
				if (title.length === 0 || title.length > 120) throw new Error('title must be 1–120 characters')
				const controller = ctx.get('sessionController')
				if (controller === undefined || typeof controller.rename !== 'function') {
					throw new Error('sessionController.rename is unavailable')
				}
				await ensureAgent(ctx, peerId)
				const renamed = await controller.rename({ sessionId: peerId, title })
				return { sessionId: peerId, title: String(renamed?.title ?? title), ...(Number.isInteger(renamed?.seq) ? { seq: Number(renamed.seq) } : {}) }
			},
		}),
		defineHubTool({
			name: 'relay_archive',
			description: 'Archive another conversation (it leaves the sidebar list and can no longer be messaged until unarchived).',
			parameters: {
				target: { type: 'string', required: true, description: 'Nickname, handle, session id, or a unique conversation title.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'archived'],
				properties: { sessionId: { type: 'string' }, archived: { type: 'boolean' } },
			},
			run: async (args, exec) => {
				const callerId = callerIdOf(exec)
				const peerId = await resolveTarget(ctx, store, callerId, args.target)
				if (peerId === callerId) throw new Error('a conversation cannot archive itself')
				const registry = ctx.get('workspaceRegistry')
				if (registry !== undefined && typeof registry.archiveSession === 'function') {
					await registry.archiveSession(peerId)
					return { sessionId: peerId, archived: true }
				}
				const controller = ctx.get('workspaceController')
				if (controller !== undefined && typeof controller.archiveSession === 'function') {
					await controller.archiveSession({ sessionId: peerId })
					return { sessionId: peerId, archived: true }
				}
				throw new Error('no workspace service can archive a conversation in this deployment')
			},
		}),
		defineHubTool({
			name: 'relay_attach',
			description: 'Repair an ungrouped conversation: attach it to the workspace that owns its working directory so the '
				+ 'sidebar groups it again. Conversations created before the workspace fix stay ungrouped until repaired.',
			parameters: {
				target: { type: 'string', required: true, description: 'Nickname, handle, session id, or a unique conversation title.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'attached'],
				properties: {
					sessionId: { type: 'string' },
					attached: { type: 'boolean' },
					workspaceId: { type: 'string' },
					workspaceTitle: { type: 'string' },
					cwd: { type: 'string' },
				},
			},
			run: async (args, exec) => {
				const callerId = callerIdOf(exec)
				const peerId = await resolveTarget(ctx, store, callerId, args.target)
				let cwd = String(liveAgentOf(ctx, peerId)?.session?.header?.cwd ?? '')
				if (cwd.length === 0) {
					try {
						const inspected = await ctx.get('sessionController')?.inspect?.(peerId, undefined)
						cwd = String(inspected?.meta?.header?.cwd ?? '')
					} catch {
						cwd = ''
					}
				}
				if (cwd.length === 0) throw new Error(`conversation "${args.target}" has no readable working directory to attach from`)
				const workspace = await workspaceForPath(ctx, cwd)
				if (workspace === undefined) throw new Error(`no workspace owns "${cwd}"`)
				let attached = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(peerId)
				if (attached === false && typeof workspace.attachSession === 'function') {
					await workspace.attachSession(peerId)
					attached = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(peerId)
				}
				return {
					sessionId: peerId,
					attached,
					cwd,
					workspaceId: String(workspace.id),
					workspaceTitle: String(workspace.title ?? ''),
				}
			},
		}),
		defineHubTool({
			name: 'relay_rule',
			description: 'Declare a standing rule for YOUR OWN tool calls, and list or remove rules. Phases: before vetoes a '
				+ 'pending call, after rejects a completed result and asks the model to correct it, input restates a constraint '
				+ 'when a step begins. Rules are per conversation, persist across restarts, and never affect other conversations.',
			parameters: {
				action: { type: 'string', required: true, enum: ['add', 'list', 'remove'], description: 'add | list | remove.' },
				id: { type: 'string', description: 'Rule id, required by remove.' },
				phase: { type: 'string', enum: ['before', 'after', 'input'], description: 'When the rule fires (add only).' },
				tool: { type: 'string', description: "Tool name the rule watches, or '*' for every tool (default '*')." },
				match: { type: 'string', description: 'Substring that must appear in the serialized call arguments; omit to match every call.' },
				resultMatch: { type: 'string', description: 'after rules: substring that must appear in the serialized result.' },
				ruleAction: { type: 'string', enum: ['block', 'warn'], description: 'before rules: block denies the call; warn only records a hit.' },
				text: { type: 'string', description: 'The rule text shown to this conversation when it fires.' },
				once: { type: 'string', enum: ['turn', 'session'], description: 'input rules: restate once per turn (default) or once per session.' },
			},
			output: {
				type: 'object',
				additionalProperties: false,
				required: ['action', 'rules'],
				properties: {
					action: { type: 'string' },
					removed: { type: 'string' },
					rules: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['id', 'phase', 'tool', 'match', 'text'],
							properties: {
								id: { type: 'string' },
								phase: { type: 'string' },
								tool: { type: 'string' },
								match: { type: 'string' },
								resultMatch: { type: 'string' },
								action: { type: 'string' },
								text: { type: 'string' },
								once: { type: 'string' },
								hits: { type: 'integer' },
							},
						},
					},
				},
			},
			run: async (args, exec) => {
				const ownerId = callerIdOf(exec)
				const own = () => store.state.rules.filter((rule) => rule.owner === ownerId)
				const view = (rule) => ({
					id: String(rule.id),
					phase: String(rule.phase),
					tool: String(rule.tool ?? '*'),
					match: String(rule.match ?? ''),
					resultMatch: String(rule.resultMatch ?? ''),
					action: String(rule.action ?? 'block'),
					text: String(rule.text ?? ''),
					once: String(rule.once ?? 'turn'),
					hits: Number(rule.hits ?? 0),
				})
				if (args.action === 'list') return { action: 'list', rules: own().map(view) }
				if (args.action === 'remove') {
					const id = String(args.id ?? '').trim()
					if (id.length === 0) throw new Error('remove requires id')
					const before = store.state.rules.length
					store.state.rules = store.state.rules.filter((rule) => !(rule.owner === ownerId && rule.id === id))
					store.save()
					if (store.state.rules.length === before) throw new Error(`no rule "${id}" belongs to this conversation`)
					return { action: 'remove', removed: id, rules: own().map(view) }
				}
				if (!['before', 'after', 'input'].includes(String(args.phase))) {
					throw new Error('add requires phase: before | after | input')
				}
				const text = String(args.text ?? '').trim()
				if (text.length === 0) throw new Error('add requires text')
				if (own().length >= 50) throw new Error('this conversation already holds 50 rules; remove one first')
				const created = {
					id: randomUUID().slice(0, 8),
					owner: ownerId,
					phase: String(args.phase),
					tool: typeof args.tool === 'string' && args.tool.length > 0 ? args.tool : '*',
					match: typeof args.match === 'string' ? args.match : '',
					resultMatch: typeof args.resultMatch === 'string' ? args.resultMatch : '',
					action: args.ruleAction === 'warn' ? 'warn' : 'block',
					text,
					once: args.once === 'session' ? 'session' : 'turn',
					hits: 0,
					at: Date.now(),
				}
				store.state.rules.push(created)
				store.save()
				return { action: 'add', rules: own().map(view) }
			},
		}),
	]
}

/** The title a listing row carries, when the row itself has one. */
function targetTitle(row) {
	return row?.title ?? row?.projections?.title ?? undefined
}

/**
 * Install the three rule stages this conversation declared for itself.
 *
 * Rules only ever fire for the conversation that declared them (`rule.owner`),
 * so a rule can never police a peer. Each stage fails open: an internal defect
 * logs and falls through to the Harness's own decision instead of blocking work.
 * @param ctx - host context.
 * @param store - durable handle, link, delivery and rule store.
 */
function registerGuards(ctx, store) {
	/** rule id -> the turn (or 'session') its constraint was already asserted for. */
	const asserted = new Map()

	const rulesOf = (ownerId, phase) =>
		store.state.rules.filter((rule) => rule.owner === ownerId && rule.phase === phase)

	const recordHit = (rule) => {
		try {
			rule.hits = Number(rule.hits ?? 0) + 1
			store.save()
		} catch {
			/* a hit counter must never fail the call it describes */
		}
	}

	ctx.on('tools/pre-execute', async (exec, next) => {
		let rule
		try {
			const ownerId = exec.agent === undefined ? undefined : String(exec.agent.id)
			if (ownerId === undefined) return await next()
			rule = selectCallRule(rulesOf(ownerId, 'before'), String(exec.name), serializeForMatch(exec.arguments), '')
		} catch (error) {
			// A rule is policy on top of the pipeline: a defect here must not block a
			// call the Harness would otherwise allow.
			ctx.logger?.warn?.(`session-relay: before rule failed: ${String(error)}`)
			return await next()
		}
		if (rule === undefined) return await next()
		recordHit(rule)
		if (String(rule.action ?? 'block') !== 'block') return await next()
		return { kind: 'deny', reason: `Blocked by standing rule ${rule.id}: ${rule.text}` }
	})

	ctx.on('tools/post-execute', async (exec, result, next) => {
		const decision = await next()
		try {
			const ownerId = exec.agent === undefined ? undefined : String(exec.agent.id)
			if (ownerId === undefined) return decision
			const rule = selectCallRule(
				rulesOf(ownerId, 'after'),
				String(exec.name),
				serializeForMatch(exec.arguments),
				serializeForMatch(result),
			)
			if (rule === undefined) return decision
			recordHit(rule)
			return {
				kind: 'block',
				feedback: [{
					type: 'text',
					text: `Rejected by standing rule ${rule.id}: ${rule.text}\nThe result above was discarded. Correct the problem and call the tool again.`,
				}],
			}
		} catch (error) {
			ctx.logger?.warn?.(`session-relay: after rule failed: ${String(error)}`)
			return decision
		}
	})

	ctx.on('agent/pre-step', async (payload, next) => {
		const decision = await next()
		try {
			if (decision.kind !== 'enter') return decision
			const ownerId = String(payload.agent.id)
			const rules = rulesOf(ownerId, 'input')
			if (rules.length === 0) return decision
			const incoming = serializeForMatch(decision.messages)
			const due = rules.filter((rule) => {
				if (ruleTextMatches(rule, incoming) === false) return false
				if (String(rule.once ?? 'turn') === 'session') {
					if (asserted.get(rule.id) === 'session') return false
					asserted.set(rule.id, 'session')
					return true
				}
				if (asserted.get(rule.id) === String(payload.turn)) return false
				asserted.set(rule.id, String(payload.turn))
				return true
			})
			if (due.length === 0) return decision
			for (const rule of due) recordHit(rule)
			return { ...decision, messages: [...decision.messages, ...due.map((rule) => ruleMessage(ownerId, rule))] }
		} catch (error) {
			ctx.logger?.warn?.(`session-relay: input rule failed: ${String(error)}`)
			return decision
		}
	})
}
