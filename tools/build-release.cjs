#!/usr/bin/env node
'use strict'
/**
 * Audit this package as a REAL user receives it, then build the zip.
 *
 * Every check here exists because something already broke once:
 *   - a client half that registered the wrong module id took the whole web boot down;
 *   - a package that imported a non-builtin dragged an unsatisfiable dependency in;
 *   - a cordis row naming a different package made the row unresolvable;
 *   - `engines.dsh` decided whether the host accepts the plugin at all;
 *   - `files` decides what actually lands in the tarball.
 *
 * Usage:
 *   node tools/build-release.cjs          # audit, then write dist/*.zip
 *   node tools/build-release.cjs --check  # audit only
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PLUGIN = path.join(ROOT, 'plugin')
const DIST = path.join(ROOT, 'dist')
const EXPECTED_NAME = 'dsh-session-relay'
/** The host version this build must stay installable on. */
const RUNTIME_MANIFEST = 'C:/Users/G1enn/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json'

const errors = []
/**
 * Record a failure.
 * @param message what is wrong, phrased so it says what to fix.
 */
function fail(message) {
	errors.push(message)
}

/**
 * Semver, resolved from pnpm's own distribution: build-time only, never shipped.
 * @returns the module, or undefined when it cannot be found.
 */
function loadSemver() {
	for (const candidate of [
		process.env.DSH_SEMVER,
		'C:/Users/G1enn/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/dist/node_modules/semver'
	]) {
		if (!candidate) continue
		try {
			return require(candidate)
		} catch {
			/* try the next one */
		}
	}
	try {
		return require('semver')
	} catch {
		return undefined
	}
}

/**
 * The DSH the audit validates against: the local runtime manifest, or DSH_RUNTIME_VERSION.
 * @returns the version, or undefined when unknown.
 */
function runningDshVersion() {
	const explicit = (process.env.DSH_RUNTIME_VERSION ?? '').trim()
	if (explicit !== '') return explicit
	try {
		const manifest = JSON.parse(fs.readFileSync(RUNTIME_MANIFEST, 'utf8'))
		return typeof manifest.desktopVersion === 'string' ? manifest.desktopVersion : undefined
	} catch {
		return undefined
	}
}

const semver = loadSemver()

function readPackageJson() {
	return JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
}

/**
 * The dsh range must be present, well formed, and satisfied by the running host.
 * Without it the plugin claims compatibility with every future host, so the host's
 * own compatibility gate has nothing to judge.
 * @param manifest parsed package.json.
 */
function checkEngines(manifest) {
	const engines = manifest.engines
	if (engines === null || typeof engines !== 'object') {
		fail('engines is missing — declare engines.node and engines.dsh')
		return
	}
	if (typeof engines.node !== 'string' || engines.node.trim() === '') fail('engines.node is missing')
	const range = engines.dsh
	if (typeof range !== 'string' || range.trim() === '') {
		fail('engines.dsh is missing — declare the DSH range the plugin was verified against')
		return
	}
	if (!/^>=0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s+<0\.\d+\.\d+$/.test(range.trim())) {
		fail(`engines.dsh "${range}" must be ">=<floor> <ceiling>" (e.g. ">=0.2.1-rc.5 <0.3.0")`)
	}
	const host = runningDshVersion()
	if (host === undefined) {
		fail('cannot determine the running dsh version (set DSH_RUNTIME_VERSION)')
		return
	}
	if (semver === undefined) {
		fail(`semver is unavailable, cannot check engines.dsh against ${host}`)
		return
	}
	if (!semver.satisfies(host, range.trim(), { includePrerelease: true })) {
		fail(`engines.dsh "${range}" does not accept the running dsh ${host}`)
	}
}

/**
 * The manifest must describe a publishable package.
 * @param manifest parsed package.json.
 */
function checkManifest(manifest) {
	if (manifest.name !== EXPECTED_NAME) fail(`name must be ${EXPECTED_NAME} (got ${JSON.stringify(manifest.name)})`)
	if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
		fail(`version is not a valid semver (got ${JSON.stringify(manifest.version)})`)
	}
	if (manifest.private === true) fail('package.json still says "private": true — npm refuses to publish it')
	if (manifest.license !== 'MIT') fail(`license must be MIT (got ${JSON.stringify(manifest.license)})`)
	if (manifest.publishConfig?.access !== 'public') fail('publishConfig.access must be "public"')
	if (manifest.type !== 'module') fail('type must be "module"')
	if (manifest.main !== 'lib/host.js') fail(`main must be lib/host.js (got ${JSON.stringify(manifest.main)})`)
	if (manifest.exports?.['.'] !== './lib/host.js') fail('exports["."] must be ./lib/host.js')
	if (manifest.exports?.['./client'] !== './lib/client.js') fail('exports["./client"] must be ./lib/client.js')
	if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must be ./cordis.patch.yml')
	if (manifest.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be "web"')
	if (!Array.isArray(manifest.dsh?.client?.inject) || manifest.dsh.client.inject.length === 0) {
		fail('dsh.client.inject must list the client packages the browser half requires')
	}
	if (manifest.dsh?.bundle?.platforms !== undefined) {
		fail('dsh.bundle.platforms must stay unset: this plugin runs on every platform')
	}
}

/**
 * Everything a user needs must be in `files`, or npm ships a tarball that cannot run.
 * @param manifest parsed package.json.
 */
function checkFiles(manifest) {
	const files = Array.isArray(manifest.files) ? manifest.files : []
	for (const required of [
		'lib/host.js',
		'lib/client.js',
		'cordis.patch.yml',
		'locale/*.json',
		'icon.svg',
		'docs/DETAIL.md',
		'docs/DETAIL.zh.md',
		'docs/preview.svg',
		'docs/preview.zh.svg',
		'README.md',
		'LICENSE'
	]) {
		if (!files.includes(required)) fail(`files is missing ${required}`)
	}
	for (const required of [
		'lib/host.js',
		'lib/client.js',
		'cordis.patch.yml',
		'icon.svg',
		'README.md',
		'LICENSE',
		'docs/DETAIL.md',
		'docs/DETAIL.zh.md',
		'docs/preview.svg',
		'docs/preview.zh.svg'
	]) {
		if (!fs.existsSync(path.join(PLUGIN, required))) fail(`${required} does not exist`)
	}
	const locale = path.join(PLUGIN, 'locale')
	if (!fs.existsSync(locale)) {
		fail('locale/ does not exist')
	} else if (fs.readdirSync(locale).filter((file) => file.endsWith('.json')).length === 0) {
		fail('locale/ holds no .json dictionaries')
	}
	if (fs.existsSync(path.join(PLUGIN, 'node_modules'))) fail('node_modules must not exist inside the package')
	for (const installer of ['install.ps1', 'install.sh']) {
		if (!fs.existsSync(path.join(PLUGIN, installer))) fail(`${installer} is missing`)
		if (!files.includes(installer)) fail(`files is missing ${installer}`)
	}
}

/**
 * The browser half must register the package name, or the host cannot place it.
 */
function checkClientHalf(manifest) {
	const file = path.join(PLUGIN, 'lib', 'client.js')
	if (!fs.existsSync(file)) return
	const source = fs.readFileSync(file, 'utf8')
	const id = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*['"]([^'"]+)['"]/.exec(source)?.[1]
	if (id !== manifest.name) {
		fail(`lib/client.js registers id ${JSON.stringify(id)} but the package is ${manifest.name} — the host resolves bundles BY PACKAGE NAME`)
	}
	// The browser half may use React and DSH's own client packages, nothing else: anything
	// else has to be bundled, and this package ships no dependencies.
	const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
	const allowed = /^(react|react\/jsx-runtime|@deepseek-ai\/dsh-client-[a-z-]+)$/
	for (const request of requires) {
		if (allowed.test(request) === false) fail(`lib/client.js requires ${JSON.stringify(request)} — only react and @deepseek-ai/dsh-client-* are available at runtime`)
	}
	if (/\bimport\s+[^(]/.test(source.replace(/\/\*[\s\S]*?\*\//g, ''))) {
		fail('lib/client.js must use require(), not import: the browser half is loaded by the module loader')
	}
}

/**
 * The host half may only use Node builtins — this package declares no dependencies.
 */
function checkHostHalf() {
	const file = path.join(PLUGIN, 'lib', 'host.js')
	if (!fs.existsSync(file)) return
	const source = fs.readFileSync(file, 'utf8')
	const requests = [...source.matchAll(/(?:^|\n)\s*import\s[^\n]*?from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
	if (requests.length === 0) fail('lib/host.js imports nothing — expected at least node: builtins')
	for (const request of requests) {
		if (request.startsWith('node:') === false) {
			fail(`lib/host.js imports ${JSON.stringify(request)} — only node: builtins are allowed (this package has no dependencies)`)
		}
	}
}

/**
 * The plugin page renders docs/DETAIL.<locale>.md with its images resolved relative to the
 * file, so a missing or unreferenced preview silently degrades to a wall of text — which is
 * exactly what this was asked to replace.
 */
function checkShowcase() {
	for (const [detail, preview] of [
		['docs/DETAIL.md', 'preview.svg'],
		['docs/DETAIL.zh.md', 'preview.zh.svg']
	]) {
		const file = path.join(PLUGIN, detail)
		if (fs.existsSync(file) === false) continue
		const text = fs.readFileSync(file, 'utf8')
		if (text.includes(`](${preview})`) === false) {
			fail(`${detail} does not reference ${preview} — the plugin page would show no illustration`)
		}
		for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
			const target = match[1]
			if (/^https?:/.test(target)) continue
			const resolved = path.join(path.dirname(file), target)
			if (fs.existsSync(resolved) === false) fail(`${detail} links ${target}, which does not exist`)
		}
	}
}

/**
 * The cordis row has to name this package, or the row cannot be resolved.
 * @param manifest parsed package.json.
 */
function checkPatch(manifest) {
	const file = path.join(PLUGIN, 'cordis.patch.yml')
	if (!fs.existsSync(file)) return
	const text = fs.readFileSync(file, 'utf8')
	const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((match) => match[1].trim())
	if (names.length === 0) fail('cordis.patch.yml declares no row name')
	for (const name of names) {
		if (name !== manifest.name) fail(`cordis.patch.yml row is named ${JSON.stringify(name)} but the package is ${manifest.name}`)
	}
	if (text.includes('insert:') === false) fail('cordis.patch.yml has no insert: block')
}

/**
 * Docs must not claim a version the packages do not have — that drift shipped four times.
 * @param version the version the package declares.
 */
function checkDocVersions(version) {
	const expectations = [
		['README.md', /版本[:：]\s*\**([0-9]+\.[0-9]+\.[0-9]+)/],
		['../verification/README.md', /版本[:：]\s*\**([0-9]+\.[0-9]+\.[0-9]+)/]
	]
	for (const [relative, pattern] of expectations) {
		const file = path.join(PLUGIN, relative)
		if (fs.existsSync(file) === false) continue
		const match = pattern.exec(fs.readFileSync(file, 'utf8'))
		if (match !== null && match[1] !== version) {
			fail(`${relative}: states ${match[1]} but the package is ${version}`)
		}
	}
}

/**
 * Walk the package files that belong in the zip.
 * @param directory directory to walk.
 * @param prefix path prefix for the resulting entries.
 * @returns [{ entry, abs }] pairs.
 */
function collect(directory, prefix = '') {
	const out = []
	for (const name of fs.readdirSync(directory).sort()) {
		const abs = path.join(directory, name)
		const entry = prefix === '' ? name : `${prefix}/${name}`
		const stat = fs.statSync(abs)
		if (stat.isDirectory()) {
			if (name === 'node_modules') continue
			out.push(...collect(abs, entry))
		} else {
			out.push({ entry, abs })
		}
	}
	return out
}

const ZIP_STORE = 0
const ZIP_DEFLATE = 8
const CRC_TABLE = (() => {
	const table = new Int32Array(256)
	for (let index = 0; index < 256; index += 1) {
		let value = index
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
		table[index] = value
	}
	return table
})()

/**
 * CRC-32 of a buffer, for the zip entries.
 * @param buffer bytes.
 * @returns unsigned crc.
 */
function crc32(buffer) {
	let crc = -1
	for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
	return (crc ^ -1) >>> 0
}

/**
 * Write a zip archive.
 * @param output destination path.
 * @param entries [{ entry, abs }] files.
 */
function writeZip(output, entries) {
	const zlib = require('node:zlib')
	const locals = []
	const centrals = []
	let offset = 0
	for (const { entry, abs } of entries) {
		const data = fs.readFileSync(abs)
		const deflated = zlib.deflateRawSync(data, { level: 9 })
		const useDeflate = deflated.length < data.length
		const body = useDeflate ? deflated : data
		const name = Buffer.from(entry, 'utf8')
		const crc = crc32(data)

		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(0, 6)
		local.writeUInt16LE(useDeflate ? ZIP_DEFLATE : ZIP_STORE, 8)
		local.writeUInt16LE(0, 10)
		local.writeUInt16LE(0x21, 12)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(body.length, 18)
		local.writeUInt32LE(data.length, 22)
		local.writeUInt16LE(name.length, 26)
		local.writeUInt16LE(0, 28)
		locals.push(local, name, body)

		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(20, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(0, 8)
		central.writeUInt16LE(useDeflate ? ZIP_DEFLATE : ZIP_STORE, 10)
		central.writeUInt16LE(0, 12)
		central.writeUInt16LE(0x21, 14)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(body.length, 20)
		central.writeUInt32LE(data.length, 24)
		central.writeUInt16LE(name.length, 28)
		central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
		central.writeUInt32LE(offset, 42)
		centrals.push(central, name)

		offset += local.length + name.length + body.length
	}
	const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(centralSize, 12)
	end.writeUInt32LE(offset, 16)
	fs.mkdirSync(path.dirname(output), { recursive: true })
	fs.writeFileSync(output, Buffer.concat([...locals, ...centrals, end]))
}

function main() {
	const checkOnly = process.argv.includes('--check')
	const manifest = readPackageJson()

	checkManifest(manifest)
	checkEngines(manifest)
	checkFiles(manifest)
	checkClientHalf(manifest)
	checkHostHalf()
	checkPatch(manifest)
	checkShowcase()
	checkDocVersions(manifest.version)

	if (errors.length > 0) {
		console.error(`audit: ${errors.length} problem(s)`)
		for (const error of errors) console.error(`  ✗ ${error}`)
		process.exit(1)
	}
	console.log('audit: clean')

	if (checkOnly) {
		console.log(`\nchecked ${manifest.name}@${manifest.version} (no archive written)`)
		return
	}

	const entries = collect(PLUGIN).filter(({ entry }) => entry.startsWith('lib/') === false || entry.endsWith('.js'))
	const zip = path.join(DIST, `${manifest.name}-${manifest.version}.zip`)
	writeZip(zip, collect(PLUGIN))
	const size = fs.statSync(zip).size
	console.log(`\nwrote ${path.relative(ROOT, zip)} (${(size / 1024).toFixed(1)} KB, ${entries.length} files)`)
}

main()
