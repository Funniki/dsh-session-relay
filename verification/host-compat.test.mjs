#!/usr/bin/env node
/**
 * Does this plugin still fit a DIFFERENT DSH version?
 *
 * The plugin was developed against 0.2.1-rc.5 but declares `engines.dsh` up to 0.3.0, which
 * is a promise about hosts it has never met. This test borrows the other host's own
 * validator — `@deepseek-ai/dsh-tools` from that install — and asks it whether our fifteen
 * tool definitions are acceptable there, so a schema the newer host rejects fails here
 * instead of at someone's boot.
 *
 * It is skipped when the other install is absent, so it never blocks a normal release.
 *
 * Usage:
 *   node verification/host-compat.test.mjs
 *   DSH_TOOLS_022=/path/to/@deepseek-ai/dsh-tools/lib/index.js node verification/host-compat.test.mjs
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WORKSPACE = resolve(ROOT, '..')

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

/**
 * Locate the other host's tool package.
 * @returns path to its entry module, or undefined.
 */
function findOtherHostTools() {
	if (process.env.DSH_TOOLS_022) return process.env.DSH_TOOLS_022
	const store = join(WORKSPACE, '_tmp', 'host022', 'node_modules', '.pnpm')
	if (existsSync(store) === false) return undefined
	for (const entry of readdirSync(store)) {
		if (entry.startsWith('@deepseek-ai+dsh-tools@0.2.') === false) continue
		const candidate = join(store, entry, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
		if (existsSync(candidate)) return candidate
	}
	return undefined
}

const otherTools = findOtherHostTools()
if (otherTools === undefined) {
	console.log('skip: no second DSH install found (set DSH_TOOLS_022 to check one)')
	process.exit(0)
}
console.log(`checking against ${otherTools}`)

const home = mkdtempSync(join(tmpdir(), 'relay-compat-'))
process.env.DSH_HOME = home

try {
	const host = await import(pathToFileURL(join(ROOT, 'plugin/lib/host.js')).href)
	const tools = []
	const ctx = {
		tools: { register: (tool) => tools.push(tool) },
		on() {},
		logger: { info() {}, warn() {} },
		get() {},
		agents: { get() {}, async resume() {} },
		effect() { return () => {} }
	}
	host.apply(ctx, {})
	check(tools.length === 15, `apply() registers 15 tools (got ${tools.length})`)

	const hostModule = await import(pathToFileURL(otherTools).href)
	const assertSupported = hostModule.assertSupportedJsonSchema
	check(typeof assertSupported === 'function', 'the other host exposes assertSupportedJsonSchema')

	// `register()` there requires `output: { schema, render }` and then asserts both schemas
	// against the enforced subset. Feeding the compiled parameters back into the *spec*
	// converter would be a double conversion — these are already JSON Schema.
	const shape = []
	for (const tool of tools) {
		if (typeof tool.output?.render !== 'function') shape.push(`${tool.name}: output.render is not a function`)
		if (tool.output?.schema === undefined) shape.push(`${tool.name}: output.schema is missing`)
	}
	check(shape.length === 0, `every tool declares output { schema, render }${shape.length === 0 ? '' : ` — ${shape.join('; ')}`}`)

	const rejected = []
	for (const tool of tools) {
		try {
			if (typeof assertSupported === 'function') {
				assertSupported(tool.parameters)
				assertSupported(tool.output.schema)
			}
		} catch (error) {
			rejected.push(`${tool.name}: ${error.message.split('\n')[0]}`)
		}
	}
	check(rejected.length === 0, `every tool schema is accepted by the other host${rejected.length === 0 ? '' : ` — ${rejected.join('; ')}`}`)
} finally {
	rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nhost compatibility verified' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
