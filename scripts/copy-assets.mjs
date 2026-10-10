import { cpSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Copies icons and codex files next to the compiled nodes/credentials.
const roots = ['nodes', 'credentials'];
const exts = ['.svg', '.png', '.json'];

function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path);
		else if (exts.some((ext) => entry.endsWith(ext))) {
			const target = join('dist', path);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(path, target);
		}
	}
}

for (const root of roots) walk(root);
