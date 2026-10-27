"use strict";

// Release the VS Code extension.
//
//   npm run release [-- patch|minor|major] [--prerelease] [--dry-run] [--skip-tests] [--no-wait]
//
//   patch (default)  1.2.3 → 1.2.4
//   minor            1.2.3 → 1.3.0
//   major            1.2.3 → 2.0.0
//   --prerelease     publish the GitHub Release as a pre-release
//   --dry-run        check and show what would happen; change nothing
//   --skip-tests     do not run the test suite before releasing
//   --no-wait        do not wait for the release workflow
//
// The current version is the highest tag v<major>.<minor>.<patch>. Without
// any such tag, the first release uses the version in vscode/package.json
// as it is (1.0.0). The script updates the version in the manifests, commits
// "Release v<version>", tags it, and pushes both; the tag starts
// .github/workflows/release.yml, which builds the VSIX packages for every
// platform and creates the GitHub Release. Requires git, cmake, node, and an
// authenticated GitHub CLI (gh).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const known = new Set(["--prerelease", "--dry-run", "--skip-tests", "--no-wait"]);
const bump = positional[0] || "patch";
const dryRun = flags.has("--dry-run");

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}
if (!["patch", "minor", "major"].includes(bump) || positional.length > 1) {
  fail(`usage: npm run release [-- patch|minor|major] [--prerelease] [--dry-run] [--skip-tests] [--no-wait]`);
}
for (const flag of flags) if (!known.has(flag)) fail(`unknown option ${flag}`);

/** Run a command; return its trimmed output (or exit on failure unless `allowFailure`). */
function run(command, commandArgs, { capture = true, allowFailure = false, cwd = root } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    fail(`${command} ${commandArgs.join(" ")} failed${capture ? `:\n${result.stderr || result.stdout}` : ""}`);
  }
  return capture ? (result.stdout || "").trim() : "";
}
const git = (...a) => run("git", a);
const step = (text) => console.log(`\n▶ ${text}`);

// ---- versions ------------------------------------------------------------------------
const parse = (v) => v.split(".").map(Number);
const compare = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
function next(version, kind) {
  const [major, minor, patch] = parse(version);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const manifests = {
  json: ["vscode/package.json", "host/package.json", "vcpkg.json"],
  locks: ["vscode/package-lock.json", "host/package-lock.json"],
};
function setVersion(version) {
  const changed = [];
  const write = (file, text) => { fs.writeFileSync(path.join(root, file), text); changed.push(file); };
  for (const file of manifests.json) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    if (data.version === version) continue;
    data.version = version;
    write(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  for (const file of manifests.locks) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    if (data.version === version && data.packages?.[""]?.version === version) continue;
    data.version = version;
    if (data.packages?.[""]) data.packages[""].version = version;
    write(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  const cmake = fs.readFileSync(path.join(root, "CMakeLists.txt"), "utf8");
  const updated = cmake.replace(/^(  VERSION )\d+\.\d+\.\d+$/m, `$1${version}`);
  if (updated !== cmake) write("CMakeLists.txt", updated);
  return changed;
}

// ---- checks ---------------------------------------------------------------------------
step("Checking the repository");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") fail(`releases are made from main (current branch: ${branch})`);
if (git("status", "--porcelain")) fail("there are uncommitted changes; commit or stash them first");
git("fetch", "--quiet", "--tags", "origin");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
  fail("main is not in sync with origin/main; pull or push first");
}
const submodules = git("submodule", "status");
if (/^[+\-U]/m.test(submodules)) fail(`submodules are not at their recorded commits:\n${submodules}`);
const remote = git("remote", "get-url", "origin");
const slug = (remote.match(/github\.com[:/](.+?)(\.git)?$/) || [])[1];
if (!slug) fail(`origin is not a GitHub repository: ${remote}`);

const tags = git("tag", "--list", "v*").split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
const manifestVersion = JSON.parse(fs.readFileSync(path.join(root, "vscode/package.json"), "utf8")).version;
let current = null;
let version;
if (tags.length) {
  current = tags.map((t) => t.slice(1)).sort((a, b) => compare(parse(a), parse(b))).pop();
  version = next(current, bump);
} else {
  version = manifestVersion;   // first release
}
const tag = `v${version}`;
if (git("tag", "--list", tag) || git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) {
  fail(`tag ${tag} already exists`);
}

console.log(`  repository:  ${slug}`);
console.log(`  current:     ${current ? `v${current}` : "(no release yet)"}`);
console.log(`  release:     ${tag}${current ? ` (${bump})` : " (first release: version from vscode/package.json)"}`);
console.log(`  pre-release: ${flags.has("--prerelease") ? "yes" : "no"}`);
console.log(`  submodules:\n${submodules.replace(/^/gm, "    ")}`);

if (dryRun) {
  console.log(`\nDry run: would set version ${version}, commit "Release ${tag}", tag ${tag}, and push main and ${tag}.`);
  process.exit(0);
}
run("gh", ["auth", "status"]);

// ---- tests ----------------------------------------------------------------------------
if (!flags.has("--skip-tests")) {
  step("Building the backend and running the tests");
  if (!fs.existsSync(path.join(root, "build", "CMakeCache.txt"))) {
    fail("build/ is not configured; run `cmake -S . -B build` once, or pass --skip-tests");
  }
  run("cmake", ["--build", "build"], { capture: false });
  run("node", ["--test", "tests/"], { capture: false });
}

// ---- version, commit, tag, push ----------------------------------------------------------
step(`Releasing ${tag}`);
const changed = setVersion(version);
if (changed.length) {
  run("git", ["add", ...changed]);
  run("git", ["commit", "--quiet", "-m", `Release ${tag}`]);
  console.log(`  committed version ${version} (${changed.join(", ")})`);
}
const message = `msentity Spectrum Viewer ${tag}${flags.has("--prerelease") ? "\n\n[prerelease]" : ""}`;
run("git", ["tag", "-a", tag, "-m", message]);
run("git", ["push", "--quiet", "origin", "main"]);
run("git", ["push", "--quiet", "origin", tag]);
console.log(`  pushed main and ${tag}`);

if (flags.has("--no-wait")) {
  console.log(`\nThe release workflow builds the packages: https://github.com/${slug}/actions`);
  process.exit(0);
}

// ---- wait for the workflow --------------------------------------------------------------
step("Waiting for the release workflow (builds on Linux and Windows)");
// The run of this tag's commit (an earlier, cancelled run of a re-created tag
// has the same branch name but another commit).
const commit = git("rev-parse", `${tag}^{commit}`);
let runId = "";
for (let attempt = 0; attempt < 30 && !runId; attempt++) {
  runId = run("gh", ["run", "list", "--repo", slug, "--workflow", "release.yml", "--branch", tag,
    "--limit", "20", "--json", "databaseId,headSha",
    "--jq", `[.[] | select(.headSha == "${commit}")][0].databaseId // empty`], { allowFailure: true });
  if (!runId) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
}
if (!runId) fail(`the workflow did not start; see https://github.com/${slug}/actions`);
run("gh", ["run", "watch", runId, "--repo", slug, "--exit-status", "--interval", "30"], { capture: false });
const url = run("gh", ["release", "view", tag, "--repo", slug, "--json", "url", "--jq", ".url"]);
console.log(`\nReleased ${tag}: ${url}`);
