"use strict";

// Build a platform-specific VSIX of the extension.
//
//   node scripts/package-vsix.js [--backend <executable>] [--target <vsce target>] [--out <dir>] [--stage-only]
//
// The package contains the extension (vscode/), the UI components (ui/), the
// host library (host/) with RDKit's WebAssembly build (host/node_modules/@rdkit/rdkit,
// installed by `npm install` in host/), and the C++ backend for one platform
// (bin/<platform>/). The backend defaults to the repository
// build (cmake --build build); build it with MSENTITY_STATIC_DEPS=ON for a
// self-contained release package.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const extensionDir = path.resolve(__dirname, "..");
const root = path.resolve(extensionDir, "..");
const { findBackendExecutable, executableName, platformId } = require(path.join(root, "host"));

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const target = option("--target", platformId());           // linux-x64, win32-x64, darwin-arm64, ...
const [targetPlatform] = target.split("-");
const backend = option("--backend", findBackendExecutable({ roots: [root] }));
const outDir = path.resolve(option("--out", path.join(root, "dist")));
const stage = path.join(outDir, `stage-${target}`);

if (!backend || !fs.existsSync(backend)) {
  console.error("Backend executable not found. Build it (cmake --build build) or pass --backend.");
  process.exit(1);
}

const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const name of ["package.json", "extension.js", "README.md", "CHANGELOG.md", ".vscodeignore", "media"]) {
  const source = path.join(extensionDir, name);
  if (fs.existsSync(source)) copy(source, path.join(stage, name));
}
copy(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
copy(path.join(root, "THIRD-PARTY-NOTICES.txt"), path.join(stage, "THIRD-PARTY-NOTICES.txt"));
copy(path.join(root, "ui"), path.join(stage, "ui"));
fs.cpSync(path.join(root, "host"), path.join(stage, "host"), {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}node_modules`) && path.basename(source) !== "package-lock.json",
});

// RDKit: only the files needed at run time.
const rdkitSource = path.join(root, "host", "node_modules", "@rdkit", "rdkit");
if (!fs.existsSync(path.join(rdkitSource, "dist", "RDKit_minimal.wasm"))) {
  console.error("RDKit not found; run `npm install` in host/ first.");
  process.exit(1);
}
const rdkitTarget = path.join(stage, "host", "node_modules", "@rdkit", "rdkit");
fs.mkdirSync(path.join(rdkitTarget, "dist"), { recursive: true });
for (const name of ["package.json", "dist/RDKit_minimal.js", "dist/RDKit_minimal.wasm"]) {
  fs.copyFileSync(path.join(rdkitSource, name), path.join(rdkitTarget, name));
}
const binDir = path.join(stage, "bin", target);
fs.mkdirSync(binDir, { recursive: true });
const installed = path.join(binDir, executableName(targetPlatform));
fs.copyFileSync(backend, installed);
fs.chmodSync(installed, 0o755);
console.log(`Staged ${target} package in ${stage}`);

if (process.argv.includes("--stage-only")) process.exit(0);

const version = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")).version;
const vsix = path.join(outDir, `msentity-spectrum-viewer-${version}-${target}.vsix`);
const vsce = path.join(extensionDir, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
if (!fs.existsSync(vsce)) {
  console.error("vsce not found; run `npm install` in vscode/ first.");
  process.exit(1);
}
const result = spawnSync(vsce, ["package", "--target", target, "--out", vsix, "--allow-missing-repository"],
  { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Created ${vsix}`);
