#!/usr/bin/env node
/**
 * Verify a RELEASE the way a user receives it.
 *
 * Reading the working tree proves nothing: the tarball is what npm hands out, and the
 * failures that reached users before (a browser half registering the wrong module id,
 * a missing engine declaration, a package.json that lost its `files`) are only visible
 * in the artifact. This script therefore ignores the local tree unless asked to pack it.
 *
 * Usage:
 *   node verification/verify-release.mjs --local                      # pack here, then check
 *   node verification/verify-release.mjs --version 0.4.1              # check the registry
 *   node verification/verify-release.mjs --version 0.4.1 --tag latest # also check the tag
 *   node verification/verify-release.mjs --version 0.4.1 --install    # plus a real install
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACK = 'dsh-session-relay'
const PLUGIN = join(ROOT, 'plugin')
const RUNTIME_MANIFEST = 'C:/Users/G1enn/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json'
const PNPM = 'C:/Users/G1enn/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs'
const TAR = 'C:/Windows/System32/tar.exe'

/**
 * Semver for the engine check: build-time only, from pnpm's own distribution.
 * @returns the module, or undefined.
 */
function loadSemver() {
	const require = createRequire(import.meta.url)
	for (const candidate of [
		process.env.DSH_SEMVER,
		'C:/Users/G1enn/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/dist/node_modules/semver',
		'semver'
	]) {
		if (!candidate) continue
		try {
			return require(candidate)
		} catch {
			/* try the next one */
		}
	}
	return undefined
}

const semver = loadSemver()

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

const args = process.argv.slice(2)
/**
 * Read a flag's value.
 * @param flag flag name.
 * @returns its value, or undefined.
 */
function valueOf(flag) {
	const at = args.indexOf(flag)
	return at >= 0 ? args[at + 1] : undefined
}
const doLocal = args.includes('--local')
const doInstall = args.includes('--install')
const version = valueOf('--version') ?? JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')).version
const tag = valueOf('--tag')

/**
 * The DSH the checks validate against.
 * @returns version, or undefined.
 */
function runningDshVersion() {
	const explicit = (process.env.DSH_RUNTIME_VERSION ?? '').trim()
	if (explicit !== '') return explicit
	try {
		return JSON.parse(readFileSync(RUNTIME_MANIFEST, 'utf8')).desktopVersion
	} catch {
		return undefined
	}
}

/**
 * Pack the local package with pnpm, exactly as publishing would.
 * @returns path to the .tgz.
 */
function packLocal() {
	const out = join(ROOT, 'dist')
	execFileSync(process.execPath, [PNPM, 'pack', '--pack-destination', out], {
		cwd: PLUGIN,
		stdio: 'ignore'
	})
	const expected = join(out, `${PACK}-${version}.tgz`)
	if (existsSync(expected)) return expected
	const candidates = readdirSync(out).filter((file) => file.startsWith(`${PACK}-${version}`) && file.endsWith('.tgz'))
	if (candidates.length === 0) throw new Error(`pnpm pack produced no archive for ${PACK}@${version}`)
	return join(out, candidates[0])
}

/**
 * Download the published tarball.
 * @returns { path, sha1 } for the archive.
 */
async function downloadPublished() {
	const response = await fetch(`https://registry.npmjs.org/${PACK.replace('/', '%2F')}/${version}`, { cache: 'no-store' })
	if (response.status === 404) throw new Error(`${PACK}@${version} is not on the registry`)
	if (!response.ok) throw new Error(`registry returned ${response.status}`)
	const meta = await response.json()
	const bytes = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer())
	const actual = createHash('sha1').update(bytes).digest('hex')
	const file = join(mkdtempSync(join(tmpdir(), 'relay-verify-')), `${PACK}-${version}.tgz`)
	writeFileSync(file, bytes)
	return { path: file, sha1: actual, expectedSha1: meta.dist.shasum, metadata: meta }
}

/**
 * Check every property that decides whether the artifact works for a user.
 * @param directory unpacked package root.
 */
function verifyPackage(directory) {
	const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))

	check(manifest.name === PACK, `package.json declares ${PACK} (got ${manifest.name})`)
	check(manifest.version === version, `package.json version is ${version} (got ${manifest.version})`)
	check(manifest.private !== true, 'package.json is not private')
	check(manifest.license === 'MIT', `license is MIT (got ${manifest.license})`)
	check(existsSync(join(directory, 'LICENSE')), 'ships LICENSE')
	check(existsSync(join(directory, 'icon.svg')), 'ships icon.svg')
	check(existsSync(join(directory, 'cordis.patch.yml')), 'ships cordis.patch.yml')
	check(existsSync(join(directory, 'locale/zh.json')), 'ships locale/zh.json')
	check(existsSync(join(directory, 'README.md')), 'ships README.md')
	// The plugin page shows these instead of the README; without them the page reverts to
	// a wall of text, which is the thing this package is meant to avoid.
	for (const showcase of ['docs/DETAIL.md', 'docs/DETAIL.zh.md', 'docs/preview.svg', 'docs/preview.zh.svg']) {
		check(existsSync(join(directory, showcase)), `ships ${showcase}`)
	}
	const detailZh = join(directory, 'docs/DETAIL.zh.md')
	if (existsSync(detailZh)) {
		const text = readFileSync(detailZh, 'utf8')
		check(text.includes('](preview.zh.svg)'), 'DETAIL.zh.md references its preview image')
	}
	check(existsSync(join(directory, 'node_modules')) === false, 'carries no node_modules')

	// The host resolves a bundle BY PACKAGE NAME, so a mismatched id kills the whole boot.
	const clientPath = join(directory, 'lib/client.js')
	if (existsSync(clientPath)) {
		const source = readFileSync(clientPath, 'utf8')
		const id = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*['"]([^'"]+)['"]/.exec(source)?.[1]
		check(id === manifest.name, `browser half registers id ${JSON.stringify(id)} — must equal the package name`)
		const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
		const allowed = /^(react|react\/jsx-runtime|@deepseek-ai\/dsh-client-[a-z-]+)$/
		check(requires.every((request) => allowed.test(request)), `browser half requires platform modules only (${requires.join(', ')})`)
	} else {
		check(false, 'ships lib/client.js')
	}

	const hostPath = join(directory, 'lib/host.js')
	if (existsSync(hostPath)) {
		const source = readFileSync(hostPath, 'utf8')
		const requests = [...source.matchAll(/(?:^|\n)\s*import\s[^\n]*?from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
		check(
			requests.length > 0 && requests.every((request) => request.startsWith('node:')),
			`host half imports only node: builtins (${requests.join(', ')})`
		)
	} else {
		check(false, 'ships lib/host.js')
	}

	// 0.2.2 gates installation on this declaration; without it every host accepts it.
	const range = manifest.engines?.dsh
	check(typeof range === 'string' && range.trim() !== '', `declares engines.dsh (${range})`)
	const host = runningDshVersion()
	if (typeof range === 'string' && host !== undefined && semver !== undefined) {
		check(
			semver.satisfies(host, range, { includePrerelease: true }),
			`engines.dsh ${range} accepts the running dsh ${host}`
		)
	}

	const patch = existsSync(join(directory, 'cordis.patch.yml'))
		? readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')
		: ''
	check(patch.includes(`'${PACK}'`) || patch.includes(PACK), `cordis.patch.yml names ${PACK}`)
	check(manifest.exports?.['./client'] === './lib/client.js', 'exports maps ./client')
	check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch points at the shipped file')
	for (const installer of ['install.ps1', 'install.sh']) {
		check(existsSync(join(directory, installer)), `ships ${installer}`)
	}
}

const workdirs = []
try {
	let tarball
	if (doLocal) {
		tarball = packLocal()
		console.log(`packed ${tarball}`)
	} else {
		const downloaded = await downloadPublished()
		tarball = downloaded.path
		workdirs.push(tarball)
		check(downloaded.sha1 === downloaded.expectedSha1, 'tarball sha1 matches the registry metadata')
		if (tag !== undefined) {
			const meta = downloaded.metadata
			const response = await fetch(`https://registry.npmjs.org/${PACK.replace('/', '%2F')}`, { cache: 'no-store' })
			const latest = (await response.json())['dist-tags']?.[tag]
			check(latest === version, `dist-tag ${tag} points at ${version} (is ${latest})`)
			check(meta.version === version, `registry serves ${version} (got ${meta.version})`)
		}
	}

	const unpack = mkdtempSync(join(tmpdir(), 'relay-unpack-'))
	workdirs.push(unpack)
	execFileSync(TAR, ['-xzf', tarball.replace(/\//g, '\\'), '-C', unpack.replace(/\//g, '\\')])
	verifyPackage(join(unpack, 'package'))

	if (doInstall) {
		const { installIntoProfile } = await import('./install-paths.test.mjs').then((module) => module.default ?? module)
		if (typeof installIntoProfile === 'function') await installIntoProfile(version)
	}
} catch (error) {
	check(false, error.message.split('\n')[0])
} finally {
	for (const directory of workdirs) rmSync(directory, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nrelease verified — this is what a user receives' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
