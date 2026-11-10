#!/usr/bin/env node
/**
 * Drive the host half on the API a real Harness hands it.
 *
 * Importing a module proves it parses; only `apply()` proves the tools and the event
 * hooks still match what the host offers. This caught nothing yet in this package, and
 * that is the point: it runs on every release so a removed service or a renamed event
 * fails here instead of in someone's session.
 *
 * Usage: node verification/plugin-smoke.test.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

let failures = 0
/**
 * Record a check.
 * @param ok did it pass.
 * @param text what was checked.
 */
function check(ok, text) {
	if (ok === false) failures += 1
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`)
}

// A throwaway DSH_HOME: the store reads and writes state, and must never touch the real one.
const home = mkdtempSync(join(tmpdir(), 'relay-smoke-'))
process.env.DSH_HOME = home

// Seed the pre-rename state layout, with a guard that still names the old tool namespace.
// Reading it must both move the directory and rewrite the rule, or an upgrade would leave
// that guard silently disarmed.
const LEGACY_RULE_OWNER = 'session-smoke'
{
  const legacyDirectory = join(home, 'session-hub')
  mkdirSync(legacyDirectory, { recursive: true })
  writeFileSync(
    join(legacyDirectory, 'state.json'),
    `${JSON.stringify({
      version: 1,
      handles: { [LEGACY_RULE_OWNER]: 'amber-otter' },
      links: [],
      deliveries: [],
      rules: [
        {
          owner: LEGACY_RULE_OWNER,
          id: 'legacy-1',
          phase: 'before',
          tool: 'hub_send',
          match: '',
          text: 'do not send',
          action: 'block',
          once: 'turn',
          hits: 0
        }
      ]
    }, null, 2)}\n`,
    'utf8'
  )
}

try {
	const host = await import(pathToFileURL(join(ROOT, 'plugin/lib/host.js')).href)

	check(typeof host.name === 'string' && host.name.length > 0, `exports a Cordis name (${host.name})`)
	check(host.name === 'session-relay', `name is session-relay (got ${host.name})`)
	check(Array.isArray(host.inject), 'exports inject')
	check(typeof host.apply === 'function', 'exports apply')

	const tools = []
	const events = []
	const logs = []
	const ctx = {
		tools: {
			register(definition) {
				tools.push(definition)
			}
		},
		on(event, handler) {
			events.push({ event, handler })
		},
		logger: {
			info(message) {
				logs.push(message)
			},
			warn(message) {
				logs.push(message)
			}
		},
		// The tool surface and the guards reach services lazily; a stub is enough to
		// prove apply() wires everything without a live Harness.
		get() {
			return undefined
		},
		agents: {
			get() {
				return undefined
			},
			async resume() {
				throw new Error('not used in this smoke test')
			}
		},
		effect() {
			return () => {}
		}
	}

	let applied = true
	try {
		host.apply(ctx, { autoLink: true, messageForm: 'relay', defaultMode: 'queue' })
	} catch (error) {
		applied = false
		check(false, `apply() ran (${error.message.split('\n')[0]})`)
	}
	check(applied, 'apply() runs on a permissive ctx')
	check(tools.length === 15, `registers 15 tools (got ${tools.length})`)

	const names = tools.map((tool) => tool.name).sort()
	check(new Set(names).size === names.length, 'no duplicate tool names')
	for (const expected of ['relay_send', 'relay_reply', 'relay_list', 'relay_receipt', 'relay_spawn', 'relay_status', 'relay_read']) {
		check(names.includes(expected), `registers ${expected}`)
	}
	for (const tool of tools) {
		const shapeOk =
			typeof tool.name === 'string' &&
			tool.name.startsWith('relay_') &&
			typeof tool.description === 'string' &&
			tool.description.length > 0 &&
			typeof tool.parameters === 'object' &&
			tool.parameters !== null &&
			typeof tool.execute === 'function'
		if (shapeOk === false) check(false, `tool ${tool.name} has name/description/parameters/execute`)
	}
	check(true, 'every tool carries name, description, parameters and execute')

	const subscribed = events.map((entry) => entry.event).sort()
	check(subscribed.length === 3, `subscribes 3 events (got ${subscribed.length})`)
	for (const expected of ['tools/pre-execute', 'tools/post-execute', 'agent/pre-step']) {
		check(subscribed.includes(expected), `subscribes ${expected}`)
	}
	check(
		events.every((entry) => typeof entry.handler === 'function'),
		'every subscription carries a handler'
	)
	// The state directory must follow DSH_HOME, which is what makes the throwaway run safe.
	check(
		logs.some((message) => message.includes(home.replace(/\\/g, '/')) || message.includes(home)),
		'state path follows DSH_HOME'
	)
	// The guard seeded above must survive the rename: its tool name is rewritten as the
	// state is read, so an upgrade never leaves a rule pointing at a tool nobody answers to.
	const ruleTool = tools.find((tool) => tool.name === 'relay_rule')
	if (ruleTool === undefined) {
		check(false, 'relay_rule is registered')
	} else {
		try {
			const listed = await ruleTool.execute({ action: 'list' }, { agent: { id: LEGACY_RULE_OWNER } })
			const migrated = listed?.rules?.[0]
			check(migrated?.tool === 'relay_send', `legacy rule tool migrated to relay_send (got ${migrated?.tool})`)
			check(migrated?.text === 'do not send', 'legacy rule text survives')
		} catch (error) {
			check(false, `relay_rule list ran (${error.message.split('\n')[0]})`)
		}
	}
} finally {
	rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nhost smoke verified' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
