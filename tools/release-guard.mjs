#!/usr/bin/env node
/**
 * Refuse a release that only moves the version number.
 *
 * A version bump is only a release when the content changes. This compares the working
 * tree against the newest tag and fails when every changed file is a manifest or a doc,
 * which is exactly the churn this project already produced once.
 *
 * Usage: node tools/release-guard.mjs [--allow-empty]
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run git in the repository.
 * @param args git arguments.
 * @returns trimmed stdout.
 */
function git(args) {
	// stderr is swallowed: `git describe` on a repository without tags is an expected
	// state here, not an error worth showing the user.
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

const allowEmpty = process.argv.includes('--allow-empty')

let lastTag
try {
	lastTag = git(['describe', '--tags', '--abbrev=0'])
} catch {
	console.log('release-guard: no tag yet, nothing to compare against')
	process.exit(0)
}

// Compare the WORKING TREE against the tag: this runs before the release commit exists.
const changed = git(['diff', '--name-only', lastTag]).split('\n').filter(Boolean)
if (changed.length === 0) {
	console.log(`release-guard: no changes since ${lastTag}`)
	process.exit(allowEmpty ? 0 : 1)
}

// Files that never alter what a user installs: version fields, notes and build output.
const inert = /(^|\/)(package\.json|CHANGELOG\.md|AGENTS\.md)$|^dist\//
const substantive = changed.filter((file) => inert.test(file) === false)

if (substantive.length === 0) {
	console.error(`release-guard: everything since ${lastTag} is version/metadata only — nothing worth a new version`)
	for (const file of changed) console.error(`  ${file}`)
	console.error('release-guard: ship a real change, or pass --allow-empty when the release is a repair')
	process.exit(allowEmpty ? 0 : 1)
}

console.log(`release-guard: ${substantive.length} substantive file(s) changed since ${lastTag}`)
for (const file of substantive.slice(0, 12)) console.log(`  ${file}`)
if (substantive.length > 12) console.log(`  … ${substantive.length - 12} more`)
