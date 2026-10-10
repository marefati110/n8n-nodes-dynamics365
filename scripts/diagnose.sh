#!/bin/sh
# Diagnoses "Class could not be found" by loading the package the way n8n does and printing
# the real error, which n8n hides.
#
# Usage (from the host):
#   docker exec -i <n8n-container> sh < scripts/diagnose.sh
#   docker exec -i <n8n-container> sh -s 1.0.2 < scripts/diagnose.sh   # specific version

PKG="@marefati110/n8n-nodes-dynamics365"
SPEC="$PKG${1:+@$1}"

echo "== versions"
echo "n8n:  $(n8n --version 2>/dev/null | tail -n 1)"
echo "node: $(node --version)"
echo "npm:  $(npm --version)"
echo "registry: $(npm config get registry)"
env | grep -E '^(N8N_(COMMUNITY|UNVERIFIED|REINSTALL|CUSTOM_EXTENSIONS|USER_FOLDER)|NODE_PATH|NODE_OPTIONS|EXECUTIONS_MODE)' || true

NODES_DIR="${N8N_USER_FOLDER:-$HOME}/.n8n/nodes"
echo
echo "== $NODES_DIR"
cat "$NODES_DIR/package.json" 2>&1
ls "$NODES_DIR/node_modules" 2>&1 | head -n 50

echo
echo "== version of $PKG visible from this server"
npm view "$SPEC" version 2>&1 | tail -n 3

WORK=/tmp/dynamics365-diagnose
rm -rf "$WORK" && mkdir -p "$WORK" && cd "$WORK" || exit 1
echo '{"name":"diagnose","private":true}' > package.json
echo
echo "== npm install $SPEC (into $WORK)"
npm install "$SPEC" --no-audit --no-fund 2>&1 | tail -n 5
ls node_modules node_modules/@marefati110 2>&1

# n8n puts its own node_modules on NODE_PATH so community packages resolve n8n-workflow from n8n.
N8N_MODULES="$(npm root -g)/n8n/node_modules"
echo
echo "== load test (NODE_PATH=$N8N_MODULES)"
cat > load.js <<'EOF'
const path = require('path');
const root = path.join(process.cwd(), 'node_modules', '@marefati110', 'n8n-nodes-dynamics365');
let pkg;
try {
	pkg = require(path.join(root, 'package.json'));
} catch (error) {
	console.log('Package is not installed:', error.message);
	process.exit(1);
}
console.log('installed version:', pkg.version);
try {
	const workflow = require.resolve('n8n-workflow', { paths: [root] });
	console.log('n8n-workflow resolved from:', workflow);
	console.log('n8n-workflow version:', require(path.join(workflow.split('/dist/')[0], 'package.json')).version);
} catch (error) {
	console.log('n8n-workflow NOT resolvable:', error.message.split('\n')[0]);
}
for (const file of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
	const className = path.basename(file).replace(/\.(node|credentials)\.js$/, '');
	try {
		const exported = require(path.join(root, file));
		if (typeof exported[className] !== 'function') {
			console.log(`FAIL ${className}: export not found, exports are [${Object.keys(exported).join(', ')}]`);
			continue;
		}
		new exported[className]();
		console.log(`OK   ${className}`);
	} catch (error) {
		console.log(`FAIL ${className}:\n${error.stack}`);
	}
}
EOF
NODE_PATH="$N8N_MODULES" node load.js
