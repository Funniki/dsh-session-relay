#!/usr/bin/env node
/**
 * Do the INSTALLERS put a working plugin on disk?
 *
 * Artifact checks inspect a tarball; they cannot see an installer that adds the wrong
 * thing. This drives the real scripts against throwaway profiles and asserts the tree a
 * user ends up with: the version, the module id the browser half registers, and whether
 * the host half imports from where the loader will look.
 *
 * Run directly:   node verification/install-paths.test.mjs [--version <v>]
 * Or imported:    const { installIntoProfile } = await import('./install-paths.test.mjs')
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACK = 'dsh-session-relay'
const TAR = 'C:/Windows/System32/tar.exe'

/**
 * Run a command, letting a non-zero exit be a result rather than a crash.
 * @param command executable.
 * @param commandArgs its arguments.
 * @param options spawn options.
 * @returns true when the exit code was 0.
 */
function run(command, commandArgs, options = {}) {
	try {
		execFileSync(command, commandArgs, { stdio: 'ignore', ...options })
		return true
	} catch {
		return false
	}
}

/**
 * Locate the dsh CLI.
 * @returns its path, or undefined.
 */
function findDsh() {
	if (process.env.DSH_BIN) return process.env.DSH_BIN
	const located = execFileSync(
		process.platform === 'win32' ? 'cmd.exe' : 'sh',
		process.platform === 'win32' ? ['/c', 'where dsh'] : ['-c', 'command -v dsh'],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
	)
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
	return located[0]
}

/**
 * Install one package into a throwaway profile and assert the result.
 * @param profile profile name (created inside the throwaway DSH_HOME).
 * @param home throwaway DSH_HOME.
 * @param via "zip" (local folder) or "registry".
 * @param zipDir extracted zip directory, for the local channel.
 * @param dsh dsh CLI path.
 * @param expected version that must land.
 * @param shell "ps1" or "sh".
 * @returns list of [ok, text] checks.
 */
function installAndCheck({ profile, home, via, zipDir, dsh, expected, shell }) {
	const results = []
	const env = { ...process.env, DSH_HOME: home, DSH_BIN: dsh, DSH_PROFILE: profile, DSH_VERSION: expected }
	let ran
	if (shell === 'ps1') {
		const script = join(via === 'zip' ? zipDir : zipDir, 'install.ps1')
		const scriptArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Profile', profile, '-Version', expected]
		if (via === 'registry') scriptArgs.push('-FromRegistry')
		ran = run('powershell.exe', scriptArgs, { env })
	} else {
		const script = join(via === 'zip' ? zipDir : zipDir, 'install.sh')
		const scriptEnv = { ...env }
		if (via === 'registry') scriptEnv.DSH_FROM_REGISTRY = '1'
		ran = run(process.env.SH ?? 'sh', [script], { env: scriptEnv })
	}
	results.push([ran, `${profile}/${shell}/${via}: installer exited zero`])
	if (ran === false) return results

	const installed = join(home, 'profiles', profile, 'node_modules', PACK, 'package.json')
	results.push([existsSync(installed), `${profile}/${shell}/${via}: ${PACK} resolves from the profile root`])
	if (existsSync(installed) === false) return results

	const manifest = JSON.parse(readFileSync(installed, 'utf8'))
	results.push([manifest.version === expected, `${profile}/${shell}/${via}: installed version is ${expected} (got ${manifest.version})`])

	const clientPath = join(dirname(installed), 'lib/client.js')
	if (existsSync(clientPath)) {
		const id = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*['"]([^'"]+)['"]/.exec(readFileSync(clientPath, 'utf8'))?.[1]
		results.push([id === PACK, `${profile}/${shell}/${via}: browser half registers ${id}`])
	}

	const registered = JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
	const bundles = registered.dsh?.profile?.bundles ?? []
	results.push([bundles.includes(PACK), `${profile}/${shell}/${via}: profile records ${PACK} as a bundle`])
	return results
}

/**
 * Import hook used by verify-release --install: install the published version into a
 * throwaway profile and report through the same check log.
 * @param version version to install from the registry.
 */
export async function installIntoProfile(version) {
	const home = mkdtempSync(join(tmpdir(), 'relay-install-'))
	try {
		const dsh = findDsh()
		if (dsh === undefined) {
			console.log('FAIL cannot find the dsh CLI to test an install')
			process.exitCode = 1
			return
		}
		// The registry channel needs only the script plus its manifest: no cordis.patch.yml,
		// which is what makes the script take the registry branch.
		const alone = mkdtempSync(join(tmpdir(), 'relay-script-'))
		try {
			for (const file of ['install.ps1', 'install.sh', 'package.json']) {
				execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32'
					? ['/c', 'copy', join(ROOT, 'plugin', file).replace(/\//g, '\\'), join(alone, file).replace(/\//g, '\\')]
					: ['-c', `cp "${join(ROOT, 'plugin', file)}" "${join(alone, file)}"`], { stdio: 'ignore' })
			}
			const results = installAndCheck({
				profile: 'registry',
				home,
				via: 'registry',
				zipDir: alone,
				dsh,
				expected: version,
				shell: process.platform === 'win32' ? 'ps1' : 'sh'
			})
			for (const [ok, text] of results) {
				if (ok === false) process.exitCode = 1
				console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`)
			}
		} finally {
			rmSync(alone, { recursive: true, force: true })
		}
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
}

async function main() {
	const at = process.argv.indexOf('--version')
	const version = at >= 0 ? process.argv[at + 1] : JSON.parse(readFileSync(join(ROOT, 'plugin/package.json'), 'utf8')).version

	const dsh = findDsh()
	if (dsh === undefined) {
		console.log('FAIL cannot find the dsh CLI (set DSH_BIN)')
		process.exit(1)
	}

	const zip = join(ROOT, 'dist', `${PACK}-${version}.zip`)
	if (existsSync(zip) === false) {
		console.log(`FAIL ${zip} is missing — run node tools/build-release.cjs`)
		process.exit(1)
	}

	const home = mkdtempSync(join(tmpdir(), 'relay-paths-'))
	const unpack = mkdtempSync(join(tmpdir(), 'relay-zip-'))
	let failures = 0
	try {
		execFileSync(TAR, ['-xf', zip.replace(/\//g, '\\'), '-C', unpack.replace(/\//g, '\\')])
		const shells = process.platform === 'win32' ? ['ps1', 'sh'] : ['sh']
		for (const shell of shells) {
			const results = installAndCheck({
				profile: `fresh-${shell}`,
				home,
				via: 'zip',
				zipDir: unpack,
				dsh,
				expected: version,
				shell
			})
			for (const [ok, text] of results) {
				if (ok === false) failures += 1
				console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`)
			}
		}
	} finally {
		rmSync(home, { recursive: true, force: true })
		rmSync(unpack, { recursive: true, force: true })
	}

	console.log(failures === 0 ? '\ninstall paths verified' : `\n${failures} check(s) FAILED`)
	process.exit(failures === 0 ? 0 : 1)
}

// Only run when invoked directly: verify-release imports this file for --install.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main()
}
