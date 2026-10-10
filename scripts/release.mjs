#!/usr/bin/env node
/**
 * Bumps the version, publishes to npm, then commits, tags and pushes the release.
 *
 *   pnpm release            # patch: 1.0.2 -> 1.0.3
 *   pnpm release minor      # 1.0.2 -> 1.1.0
 *   pnpm release major      # 1.0.2 -> 2.0.0
 *   pnpm release 1.4.0      # explicit version
 *   pnpm release --dry-run  # everything except publishing, committing and pushing
 *
 * The bump starts from the newest version on npm (package.json only if nothing is published
 * yet), so a version that was set in package.json but never published is not skipped.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((arg) => !arg.startsWith('--')) ?? 'patch';

const run = (command, commandArgs, options = {}) =>
	execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const step = (message) => console.log(`\n▶ ${message}`);
const fail = (message) => {
	console.error(`\n✖ ${message}`);
	process.exit(1);
};

const parse = (version) => {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
	return match ? match.slice(1).map(Number) : undefined;
};
const compare = (a, b) => {
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

step('Checking git state');
if (run('git', ['status', '--porcelain'])) {
	fail('Working tree has uncommitted changes. Commit or stash them first:\n' + run('git', ['status', '--short']));
}
const branch = run('git', ['branch', '--show-current']);
console.log(`branch: ${branch}`);

step('Reading published versions from npm');
let published = [];
try {
	published = JSON.parse(run('npm', ['view', pkg.name, 'versions', '--json']));
	if (!Array.isArray(published)) published = [published];
} catch (error) {
	if (!String(error.stderr ?? error.message).includes('E404')) {
		fail(`Could not read versions from npm: ${String(error.stderr ?? error.message).split('\n')[0]}`);
	}
}
const latest = published.filter((v) => parse(v)).sort(compare).pop();
const base = latest ?? pkg.version;
console.log(`package.json: ${pkg.version}, latest on npm: ${latest ?? 'none'}`);

let next;
if (parse(bump)) {
	next = bump;
} else if (['patch', 'minor', 'major'].includes(bump)) {
	const [major, minor, patch] = parse(base);
	next = { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[bump];
} else {
	fail(`Unknown version "${bump}". Use patch, minor, major or an explicit x.y.z version.`);
}
if (latest && compare(next, latest) <= 0) fail(`Version ${next} must be greater than the published ${latest}`);
if (published.includes(next)) fail(`Version ${next} is already published`);
console.log(`releasing: ${next}`);

step('Running tests');
const tests = spawnSync('pnpm', ['test'], { stdio: 'inherit' });
if (tests.status !== 0) fail('Tests failed; nothing was changed');

step(`Setting version ${next}`);
const files = ['package.json', 'README.md'];
const original = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
const restore = () => files.forEach((file) => writeFileSync(file, original[file]));

writeFileSync('package.json', JSON.stringify({ ...pkg, version: next }, null, 2) + '\n');
writeFileSync(
	'README.md',
	original['README.md'].replace(/(n8n-nodes-dynamics365-)\d+\.\d+\.\d+(\.tgz)/g, `$1${next}$2`),
);

step(dryRun ? 'Publishing (dry run)' : 'Publishing to npm');
const publishArgs = ['publish', '--access', 'public', '--no-git-checks', '--ignore-scripts'];
if (dryRun) publishArgs.push('--dry-run');
const publish = spawnSync('pnpm', publishArgs, { stdio: 'inherit' });
if (publish.status !== 0) {
	restore();
	fail('Publishing failed; version changes were reverted');
}

if (dryRun) {
	restore();
	console.log(`\n✔ Dry run finished. ${next} would be published, committed, tagged and pushed.`);
	process.exit(0);
}

step('Committing and tagging');
run('git', ['add', ...files]);
run('git', ['commit', '-m', `release: v${next}`]);
run('git', ['tag', '-a', `v${next}`, '-m', `v${next}`]);

step('Pushing');
const push = spawnSync('git', ['push', '--follow-tags', 'origin', branch], { stdio: 'inherit' });
if (push.status !== 0) {
	console.warn(`\n⚠ Published ${next}, but the push failed. Run: git push --follow-tags origin ${branch}`);
	process.exit(0);
}

console.log(`\n✔ Released ${pkg.name}@${next}`);
