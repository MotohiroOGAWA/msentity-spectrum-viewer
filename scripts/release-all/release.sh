#!/usr/bin/env bash
# Release msentity, msentity-similarity, and msentity-spectrum-viewer without
# GitHub Actions. The three repositories are expected side by side, with this
# script in msentity-spectrum-viewer/scripts/release-all/ (or set
# MSENTITY_REPOS_DIR to their parent directory). Run the Linux steps on
# Ubuntu 22.04 (e.g. WSL), so the Linux packages work with glibc >= 2.35.
#
#   release.sh prepare <repo> [patch|minor|major]   Linux: version, build, test, commit, draft release
#   (Windows PC: release-windows.ps1, attached to the draft, builds the Windows binaries)
#   release.sh publish <repo>                       Linux: packages for both platforms, publish
#   release.sh abort   <repo>                       delete the unpublished draft release
#   release.sh status                               latest release and draft of every repository
#
# <repo>: msentity | msentity-similarity | msentity-spectrum-viewer
# DRY_RUN=1 shows what prepare/publish would do without changing anything.
#
# Work files (vcpkg, builds, packages) live in ~/.cache/msentity-release.

set -euo pipefail

OWNER=MotohiroOGAWA
TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOS_DIR="${MSENTITY_REPOS_DIR:-$(cd "$TOOLS/../../.." && pwd)}"
# Highest glibc the Linux binaries may require: they need the glibc of the
# machine that builds them, and Ubuntu 22.04 has 2.35.
GLIBC_TARGET=2.35
CACHE="${MSENTITY_RELEASE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/msentity-release}"
DRY_RUN="${DRY_RUN:-}"

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31mrelease: %s\033[0m\n' "$*" >&2; exit 1; }
usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

# ---- repositories ---------------------------------------------------------------------------

repo_name() {   # display name in titles and commits
  case "$1" in
    msentity) echo "msentity" ;;
    msentity-similarity) echo "msentity-similarity" ;;
    msentity-spectrum-viewer) echo "msentity Spectrum Viewer" ;;
    *) fail "unknown repository: $1 (msentity, msentity-similarity, msentity-spectrum-viewer)" ;;
  esac
}

latest_release() {   # tag of the latest published release of a repository, e.g. v1.2.0
  gh release view --repo "$OWNER/$1" --json tagName --jq .tagName
}

draft_tag() {   # tag of the unpublished draft release, or nothing
  gh release list --repo "$OWNER/$1" --limit 30 --json tagName,isDraft \
    --jq '[.[] | select(.isDraft)][0].tagName // empty'
}

next_version() {   # highest tag vX.Y.Z of the repository, raised by patch/minor/major
  local latest major minor patch
  latest=$(git -C "$REPO" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
  [ -n "$latest" ] || fail "$REPO has no version tag"
  IFS=. read -r major minor patch <<<"${latest#v}"
  case "$1" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *) fail "version step must be patch, minor, or major (got $1)" ;;
  esac
}

project_version() { sed -n 's/^  VERSION \([0-9.]*\)\r\{0,1\}$/\1/p' "$REPO/CMakeLists.txt"; }

require_clean_main() {
  local branch
  branch=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
  [ "$branch" = main ] || fail "$REPO is on '$branch'; merge into main and switch to main first"
  [ -z "$(git -C "$REPO" status --porcelain)" ] || fail "$REPO has uncommitted changes:
$(git -C "$REPO" status --short)"
  git -C "$REPO" fetch --quiet --tags origin
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse origin/main)" ] \
    || fail "$REPO main differs from origin/main; pull or push first"
}

# ---- tools ------------------------------------------------------------------------------------

check_tools() {
  local missing=()
  for tool in git gh cmake ninja python3 curl zip unzip tar pkg-config autoconf automake libtoolize bison flex "$@"; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  # autoconf-archive has no command; vcpkg needs its macros for some ports.
  [ -d /usr/share/aclocal ] && ls /usr/share/aclocal/ax_*.m4 >/dev/null 2>&1 || missing+=(autoconf-archive)
  if [ ${#missing[@]} -gt 0 ] && [ -n "$DRY_RUN" ]; then
    info "missing build tools (installed with apt-get on a real run): ${missing[*]}"
  elif [ ${#missing[@]} -gt 0 ]; then
    say "Installing build tools: ${missing[*]}"
    sudo apt-get update -qq
    sudo apt-get install -y -qq git cmake ninja-build python3-venv curl zip unzip tar pkg-config \
      autoconf automake autoconf-archive libtool bison flex build-essential
  fi
  gh auth status >/dev/null 2>&1 || fail "gh is not logged in; run: gh auth login"
}

glibc_version() { getconf GNU_LIBC_VERSION | awk '{print $2}'; }

# manylinux tag of wheels built here: the glibc of this machine is their minimum.
manylinux_tag() { local v; v=$(glibc_version); echo "manylinux_${v%.*}_${v#*.}_x86_64"; }

check_glibc() {   # stop on a machine whose glibc is newer than GLIBC_TARGET
  local v; v=$(glibc_version)
  [ "$(printf '%s\n%s\n' "$v" "$GLIBC_TARGET" | sort -V | tail -1)" = "$GLIBC_TARGET" ] && return
  if [ -n "${MSENTITY_RELEASE_ALLOW_NEWER_GLIBC:-}" ]; then
    info "Warning: glibc $v; the Linux packages will need glibc >= $v (MSENTITY_RELEASE_ALLOW_NEWER_GLIBC is set)."
    return
  fi
  fail "this machine has glibc $v: Linux packages built here would not run on Ubuntu 22.04/24.04.
Run the Linux steps on Ubuntu 22.04 (glibc $GLIBC_TARGET), e.g. WSL; see RELEASING.md.
(To build anyway, set MSENTITY_RELEASE_ALLOW_NEWER_GLIBC=1.)"
}

setup_vcpkg() {   # VCPKG_ROOT at the manifest baseline of $REPO, shared binary cache
  local baseline
  baseline=$(python3 -c "import json; print(json.load(open('$REPO/vcpkg.json'))['builtin-baseline'])")
  export VCPKG_ROOT="$CACHE/vcpkg"
  export VCPKG_DEFAULT_BINARY_CACHE="$CACHE/vcpkg-binary"
  mkdir -p "$VCPKG_DEFAULT_BINARY_CACHE"
  [ -d "$VCPKG_ROOT/.git" ] || git clone --quiet https://github.com/microsoft/vcpkg.git "$VCPKG_ROOT"
  if [ "$(git -C "$VCPKG_ROOT" rev-parse HEAD)" != "$baseline" ] || [ ! -x "$VCPKG_ROOT/vcpkg" ]; then
    git -C "$VCPKG_ROOT" fetch --quiet origin
    git -C "$VCPKG_ROOT" checkout --quiet "$baseline"
    "$VCPKG_ROOT/bootstrap-vcpkg.sh" -disableMetrics >/dev/null
  fi
}

python_env() {   # a venv with the packaging tools
  if [ ! -x "$CACHE/venv/bin/python" ]; then
    python3 -m venv "$CACHE/venv"
    "$CACHE/venv/bin/pip" install --quiet --upgrade pip
  fi
  "$CACHE/venv/bin/pip" install --quiet setuptools wheel numpy pyarrow pandas
  PYTHON="$CACHE/venv/bin/python"
}

dotnet_cmd() { command -v dotnet || { [ -x "$HOME/.dotnet/dotnet" ] && echo "$HOME/.dotnet/dotnet"; } || fail "dotnet not found"; }

# ---- version files ----------------------------------------------------------------------------

# Version examples in the documentation (README.md, docs/install.md,
# bindings/*/README.md): every version number x.y.z becomes the version being
# released. In msentity-similarity, a line mentioning "similarity" is about its
# own version and any other line about msentity, so a line names only one of
# them. Lines with <!-- fixed --> (notes about a particular release) are left alone.
update_docs() {   # update_docs <new version> [<new msentity version>]
  local files=("$REPO/README.md" "$REPO/docs/install.md" "$REPO"/bindings/*/README.md)
  python3 - "$REPO_ID" "$1" "${2:-}" "${files[@]}" <<'PY'
import re, sys
repo, new, new_ms, *files = sys.argv[1:]
version = re.compile(r"(?<!\d\.)(?<!\d)\d+\.\d+\.\d+(?!\.\d)(?!\d)")
for path in files:
    try:
        with open(path, encoding="utf-8", newline="") as f:
            lines = f.read().splitlines(keepends=True)
    except FileNotFoundError:
        continue
    out = []
    for line in lines:
        if "<!-- fixed -->" not in line:
            if repo != "msentity-similarity" or re.search("similarity", line, re.I):
                line = version.sub(new, line)
            elif new_ms:
                line = version.sub(new_ms, line)
        out.append(line)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("".join(out))
PY
}

set_version() {   # write $VERSION (and dependency versions) into the repository's files
  case "$REPO_ID" in
    msentity)
      (cd "$REPO"
      sed -i "s/^  VERSION [0-9.]*\(\r\{0,1\}\)$/  VERSION $VERSION\1/" CMakeLists.txt
      sed -i "s/kVersion = \"[0-9.]*\"/kVersion = \"$VERSION\"/" include/msentity/msentity.hpp
      sed -i "s/\"version\": \"[0-9.]*\"/\"version\": \"$VERSION\"/" vcpkg.json
      sed -i "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" bindings/python/pyproject.toml
      sed -i "/<artifactId>msentity<\/artifactId>/{n;s|<version>.*<|<version>$VERSION<|}" bindings/java/pom.xml
      sed -i "s/io.github.motohiroogawa:msentity:[0-9.]*/io.github.motohiroogawa:msentity:$VERSION/" bindings/java/README.md
      sed -i "s/assertEquals(\"[0-9.]*\", Dataset.version())/assertEquals(\"$VERSION\", Dataset.version())/" bindings/java/src/test/java/io/github/motohiroogawa/msentity/DatasetTest.java
      sed -i "s|<Version>.*</Version>|<Version>$VERSION</Version>|" bindings/csharp/MsEntity/MsEntity.csproj
      sed -i "s/Assert.Equal(\"[0-9.]*\", Dataset.Version)/Assert.Equal(\"$VERSION\", Dataset.Version)/" bindings/csharp/MsEntity.Tests/DatasetTests.cs) ;;
    msentity-similarity)
      (cd "$REPO"
      sed -i "s/^  VERSION [0-9.]*\(\r\{0,1\}\)$/  VERSION $VERSION\1/; s/^  GIT_TAG [^)]*)/  GIT_TAG v$MS_VERSION)/" CMakeLists.txt
      sed -i "s/kVersion = \"[0-9.]*\"/kVersion = \"$VERSION\"/" include/msentity/similarity/similarity.hpp
      sed -i "s/^version = \"[^\"]*\"/version = \"$VERSION\"/; s/msentity==[0-9.]*/msentity==$MS_VERSION/" bindings/python/pyproject.toml
      sed -i "/<artifactId>msentity-similarity<\/artifactId>/{n;s|<version>.*<|<version>$VERSION<|}" bindings/java/pom.xml
      sed -i "/<artifactId>msentity<\/artifactId>/{n;s|<version>.*<|<version>$MS_VERSION<|}" bindings/java/pom.xml
      sed -i "s|<Version>.*</Version>|<Version>$VERSION</Version>|; s|\"MsEntity\" Version=\"[^\"]*\"|\"MsEntity\" Version=\"$MS_VERSION\"|" bindings/csharp/MsEntity.Similarity/MsEntity.Similarity.csproj
      sed -i "s/\"version\": \"[0-9.]*\"/\"version\": \"$VERSION\"/" vcpkg.json
      sed -i "s/mssim_version(), \"[0-9.]*\"/mssim_version(), \"$VERSION\"/" tests/test_c_api.cpp) ;;
    msentity-spectrum-viewer)
      VERSION="$VERSION" REPO="$REPO" node -e '
        const fs = require("fs"), path = require("path"), v = process.env.VERSION, root = process.env.REPO;
        for (const file of ["vscode/package.json", "host/package.json", "vcpkg.json", "vscode/package-lock.json", "host/package-lock.json"]) {
          const p = path.join(root, file);
          if (!fs.existsSync(p)) continue;
          const data = JSON.parse(fs.readFileSync(p, "utf8"));
          data.version = v;
          if (data.packages?.[""]) data.packages[""].version = v;
          fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
        }
        const cmake = path.join(root, "CMakeLists.txt");
        fs.writeFileSync(cmake, fs.readFileSync(cmake, "utf8").replace(/^(  VERSION )\d+\.\d+\.\d+(\r?)$/m, `$1${v}$2`));' ;;
  esac
  [ "$REPO_ID" = msentity-spectrum-viewer ] || update_docs "$VERSION" "${MS_VERSION:-}"
}

# ---- Linux build ------------------------------------------------------------------------------

BUILD=""   # set by linux_build

linux_build() {   # configure, build, and test the Linux release binaries of $REPO
  BUILD="$CACHE/build/$REPO_ID"
  setup_vcpkg
  local common=(-G Ninja -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake"
    -DVCPKG_INSTALLED_DIR="$CACHE/vcpkg-installed/$REPO_ID"
    -DMSENTITY_STATIC_DEPS=ON)
  info "build directory: $BUILD (the first build of Arrow/Parquet/HDF5 takes a while)"
  case "$REPO_ID" in
    msentity)
      cmake -S "$REPO" -B "$BUILD" "${common[@]}" -DVCPKG_TARGET_TRIPLET=x64-linux \
        -DVCPKG_OVERLAY_TRIPLETS="$REPO/triplets" -DVCPKG_MANIFEST_FEATURES=tests -DMSENTITY_TEST_BINDINGS=OFF
      cmake --build "$BUILD" --parallel
      ctest --test-dir "$BUILD" --output-on-failure ;;
    msentity-similarity)
      cmake -S "$REPO" -B "$BUILD" "${common[@]}" -DVCPKG_TARGET_TRIPLET=x64-linux \
        -DVCPKG_OVERLAY_TRIPLETS="$REPO/triplets" -DMSENTITY_SIMILARITY_TEST_BINDINGS=OFF
      cmake --build "$BUILD" --parallel
      ctest --test-dir "$BUILD" --output-on-failure ;;
    msentity-spectrum-viewer)
      cmake -S "$REPO" -B "$BUILD" "${common[@]}" -DVCPKG_TARGET_TRIPLET=x64-linux
      cmake --build "$BUILD" --parallel --target msentity-viewer-backend
      (cd "$REPO/host" && npm ci --ignore-scripts --silent)
      (cd "$REPO/vscode" && npm ci --silent)
      node "$REPO/scripts/smoke-backend.js" "$BUILD/backend/msentity-viewer-backend"
      MSENTITY_VIEWER_BACKEND="$BUILD/backend/msentity-viewer-backend" node "$REPO/scripts/run-tests.js" ;;
  esac
}

# ---- prepare ----------------------------------------------------------------------------------

prepare() {
  local bump="${1:-patch}"
  say "Checking $REPO_ID"
  check_tools node
  require_clean_main
  local existing; existing=$(draft_tag "$REPO_ID")
  [ -z "$existing" ] || fail "a draft release $existing already exists; publish it (release.sh publish $REPO_ID) or delete it (release.sh abort $REPO_ID)"
  VERSION=$(next_version "$bump")
  git -C "$REPO" ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1 \
    && fail "tag v$VERSION already exists on GitHub"
  info "released: $(git -C "$REPO" tag --list 'v*' | sort -V | tail -1)  →  new: v$VERSION ($bump)"
  case "$REPO_ID" in
    msentity-similarity)
      MS_VERSION=$(latest_release msentity); MS_VERSION=${MS_VERSION#v}
      info "depends on msentity $MS_VERSION (its latest release)" ;;
    msentity-spectrum-viewer)
      MS_TAG=$(latest_release msentity); SIM_TAG=$(latest_release msentity-similarity)
      info "submodules: msentity $MS_TAG, msentity-similarity $SIM_TAG (their latest releases)" ;;
  esac
  check_glibc
  if [ -n "$DRY_RUN" ]; then
    info "dry run: would set the version, build and test on Linux, commit \"Release $(repo_name "$REPO_ID") v$VERSION\","
    info "push main, and create the draft release v$VERSION for the Windows build."
    return
  fi

  say "Setting version $VERSION"
  if [ "$REPO_ID" = msentity-spectrum-viewer ]; then
    git -C "$REPO/external/msentity" fetch --quiet --tags && git -C "$REPO/external/msentity" checkout --quiet "$MS_TAG"
    git -C "$REPO/external/msentity-similarity" fetch --quiet --tags && git -C "$REPO/external/msentity-similarity" checkout --quiet "$SIM_TAG"
  fi
  set_version
  git -C "$REPO" status --short

  say "Building and testing on Linux"
  if ! linux_build; then
    fail "the Linux build or tests failed. The version change is not committed; undo it with:
  git -C $REPO checkout -- . && git -C $REPO submodule update"
  fi

  say "Committing and pushing main"
  git -C "$REPO" add -u
  git -C "$REPO" commit --quiet -m "Release $(repo_name "$REPO_ID") v$VERSION"
  git -C "$REPO" push --quiet origin main
  local commit; commit=$(git -C "$REPO" rev-parse HEAD)
  info "commit ${commit:0:7}"

  say "Creating the draft release v$VERSION"
  gh release create "v$VERSION" --repo "$OWNER/$REPO_ID" --draft --target "$commit" \
    --title "$(repo_name "$REPO_ID") v$VERSION" \
    --notes "Draft: waiting for the Windows build (release-windows.ps1), then release.sh publish." \
    "$TOOLS/release-windows.ps1"
  cat <<EOF

Linux build done. Next, on the Windows PC (PowerShell), run the block for
$REPO_ID in RELEASING.md ("Windows"), then here:

  bash $TOOLS/release.sh publish $REPO_ID
EOF
}

# ---- publish ----------------------------------------------------------------------------------

copy_native() { mkdir -p "$(dirname "$2")"; cp -L "$1" "$2"; }

c_api_zip() {   # c_api_zip <name> <files...>: <name>.zip of include/, lib/, LICENSE (headers via HEADERS)
  local name="$1"; shift
  local dir="$WORK/c/$name"
  rm -rf "$dir"; mkdir -p "$dir/lib"
  for header in "${HEADERS[@]}"; do
    mkdir -p "$dir/include/$(dirname "${header#*:}")"
    cp "${header%%:*}" "$dir/include/${header#*:}"
  done
  cp "$@" "$dir/lib/"
  cp "$REPO/LICENSE" "$dir/"
  (cd "$WORK/c" && cmake -E tar cf "$OUT/$name.zip" --format=zip "$name")
}

publish() {
  say "Checking $REPO_ID"
  check_tools node mvn java
  check_glibc
  VERSION=$(draft_tag "$REPO_ID"); VERSION=${VERSION#v}
  [ -n "$VERSION" ] || fail "no draft release; run release.sh prepare $REPO_ID first"
  local tag="v$VERSION"
  local commit; commit=$(gh release view "$tag" --repo "$OWNER/$REPO_ID" --json targetCommitish --jq .targetCommitish)
  git -C "$REPO" fetch --quiet --tags origin
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$commit" ] \
    || fail "$REPO is not at the release commit ${commit:0:7}; run: git -C $REPO checkout main && git -C $REPO pull"
  [ "$(project_version)" = "$VERSION" ] || fail "CMakeLists.txt has $(project_version), not $VERSION"
  local windows="windows-x64-$REPO_ID-$VERSION.zip"
  gh release view "$tag" --repo "$OWNER/$REPO_ID" --json assets --jq '.assets[].name' | grep -qx "$windows" \
    || fail "the draft has no $windows yet; run the Windows step first"
  info "release $tag (commit ${commit:0:7}) with the Windows build $windows"
  if [ -n "$DRY_RUN" ]; then info "dry run: would build the packages, attach them, and publish $tag."; return; fi

  WORK="$CACHE/work/$REPO_ID"; OUT="$CACHE/dist/$REPO_ID/$tag"
  rm -rf "$WORK" "$OUT"; mkdir -p "$WORK/windows" "$OUT"
  gh release download "$tag" --repo "$OWNER/$REPO_ID" --pattern "$windows" --dir "$WORK"
  (cd "$WORK/windows" && cmake -E tar xf "../$windows")

  BUILD="$CACHE/build/$REPO_ID"
  say "Linux binaries (rebuilding from the cache if needed)"
  setup_vcpkg
  if [ -f "$BUILD/CMakeCache.txt" ]; then
    cmake --build "$BUILD" --parallel $([ "$REPO_ID" = msentity-spectrum-viewer ] && echo --target msentity-viewer-backend)
  else
    linux_build
  fi

  say "Packages"
  local wheel_tag; wheel_tag=$(manylinux_tag)
  case "$REPO_ID" in
    msentity)          package_msentity "$wheel_tag" ;;
    msentity-similarity) package_similarity "$wheel_tag" ;;
    msentity-spectrum-viewer) package_viewer ;;
  esac
  ls -la "$OUT"

  say "Publishing $tag"
  local notes="$WORK/notes.md"
  release_notes > "$notes"
  gh release upload "$tag" --repo "$OWNER/$REPO_ID" --clobber "$OUT"/*
  for asset in "$windows" release-windows.ps1; do
    gh release delete-asset "$tag" "$asset" --repo "$OWNER/$REPO_ID" --yes >/dev/null 2>&1 || true
  done
  gh release edit "$tag" --repo "$OWNER/$REPO_ID" --notes-file "$notes" --draft=false --latest
  git -C "$REPO" fetch --quiet --tags origin
  info "$(gh release view "$tag" --repo "$OWNER/$REPO_ID" --json url --jq .url)"
  verify
}

package_msentity() {
  local natives="$REPO/bindings/natives"
  rm -rf "$natives"
  copy_native "$BUILD/libmsentity_c.so" "$natives/linux-x64/libmsentity_c.so"
  copy_native "$WORK/windows/msentity_c.dll" "$natives/win-x64/msentity_c.dll"
  python_env
  "$PYTHON" "$REPO/bindings/python/build_wheel.py" --native "$natives/linux-x64/libmsentity_c.so" --platform-tag "$1" --out "$OUT"
  "$PYTHON" "$REPO/bindings/python/build_wheel.py" --native "$natives/win-x64/msentity_c.dll" --platform-tag win_amd64 --out "$OUT"
  "$CACHE/venv/bin/pip" install --quiet --force-reinstall --no-deps "$OUT"/msentity-*manylinux*.whl
  MSENTITY_TEST_INSTALLED=1 "$PYTHON" -m unittest discover -s "$REPO/bindings/python/tests" -t "$REPO/bindings/python/tests"
  # The Java and C# tests default to the development build in $REPO/build when
  # it exists: point them at the release library instead.
  (cd "$REPO/bindings/java" && mvn -q -B package -Dmsentity.library="$natives/linux-x64/libmsentity_c.so")
  cp "$REPO/bindings/java/target/msentity-$VERSION.jar" "$OUT/"
  cp "$REPO/bindings/java/pom.xml" "$OUT/msentity-$VERSION.pom"
  MSENTITY_C_LIBRARY="$natives/linux-x64/libmsentity_c.so" "$(dotnet_cmd)" test "$REPO/bindings/csharp/MsEntity.slnx"
  "$(dotnet_cmd)" pack "$REPO/bindings/csharp/MsEntity/MsEntity.csproj" -c Release -o "$OUT"
  HEADERS=("$REPO/include/msentity/c/msentity_c.h:msentity/c/msentity_c.h")
  c_api_zip "msentity-c-$VERSION-linux-x64" "$natives/linux-x64/libmsentity_c.so"
  c_api_zip "msentity-c-$VERSION-win-x64" "$WORK/windows/msentity_c.dll" "$WORK/windows/msentity_c.lib"
}

package_similarity() {
  local natives="$REPO/bindings/natives"
  MS_VERSION=$(sed -n 's/^[[:space:]]*GIT_TAG v\([0-9.]*\)).*/\1/p' "$REPO/CMakeLists.txt")
  rm -rf "$natives"
  copy_native "$BUILD/libmsentity_similarity_c.so" "$natives/linux-x64/libmsentity_similarity_c.so"
  copy_native "$BUILD/_deps/msentity-build/libmsentity_c.so" "$natives/linux-x64/libmsentity_c.so"
  copy_native "$WORK/windows/msentity_similarity_c.dll" "$natives/win-x64/msentity_similarity_c.dll"
  copy_native "$WORK/windows/msentity_c.dll" "$natives/win-x64/msentity_c.dll"
  python_env
  "$PYTHON" "$REPO/bindings/python/build_wheel.py" --native "$natives/linux-x64/libmsentity_similarity_c.so" --platform-tag "$1" --out "$OUT"
  "$PYTHON" "$REPO/bindings/python/build_wheel.py" --native "$natives/win-x64/msentity_similarity_c.dll" --platform-tag win_amd64 --out "$OUT"
  # Java and C# packages are built against the msentity release they depend on.
  local ms="$CACHE/src/msentity-$MS_VERSION"
  [ -d "$ms/.git" ] || git clone --quiet --branch "v$MS_VERSION" "https://github.com/$OWNER/msentity.git" "$ms"
  mvn -q -B -f "$ms/bindings/java/pom.xml" install -DskipTests
  mvn -q -B -f "$REPO/bindings/java/pom.xml" package -DskipTests
  cp "$REPO/bindings/java/target/msentity-similarity-$VERSION.jar" "$OUT/"
  cp "$REPO/bindings/java/pom.xml" "$OUT/msentity-similarity-$VERSION.pom"
  local packages="$WORK/local-packages"
  "$(dotnet_cmd)" pack "$ms/bindings/csharp/MsEntity/MsEntity.csproj" -c Release -o "$packages"
  "$(dotnet_cmd)" restore "$REPO/bindings/csharp/MsEntity.Similarity/MsEntity.Similarity.csproj" \
    -p:UseMsEntityPackage=true --source "$packages" --source https://api.nuget.org/v3/index.json
  "$(dotnet_cmd)" pack "$REPO/bindings/csharp/MsEntity.Similarity/MsEntity.Similarity.csproj" \
    -c Release -o "$OUT" -p:UseMsEntityPackage=true --no-restore
  HEADERS=("$REPO/include/msentity/similarity/c/msentity_similarity_c.h:msentity/similarity/c/msentity_similarity_c.h"
           "$BUILD/_deps/msentity-src/include/msentity/c/msentity_c.h:msentity/c/msentity_c.h")
  c_api_zip "msentity-similarity-c-$VERSION-linux-x64" \
    "$natives/linux-x64/libmsentity_similarity_c.so" "$natives/linux-x64/libmsentity_c.so"
  c_api_zip "msentity-similarity-c-$VERSION-win-x64" \
    "$WORK/windows/msentity_similarity_c.dll" "$WORK/windows/msentity_c.dll" \
    "$WORK/windows/msentity_similarity_c.lib" "$WORK/windows/msentity_c.lib"
}

package_viewer() {
  local exe="$WORK/windows/msentity-viewer-backend.exe" backend="$BUILD/backend/msentity-viewer-backend"
  (cd "$REPO/host" && npm ci --ignore-scripts --silent)
  (cd "$REPO/vscode" && npm ci --silent)
  for variant in "" --no-rdkit; do
    node "$REPO/vscode/scripts/package-vsix.js" --target linux-x64 --backend "$backend" --out "$WORK/vsix" $variant
    node "$REPO/vscode/scripts/package-vsix.js" --target win32-x64 --backend "$exe" --out "$WORK/vsix" $variant
  done
  for file in "$WORK"/vsix/*.vsix; do
    cp "$file" "$OUT/"
    cp "$file" "$OUT/$(basename "$file" | sed "s/-$VERSION-/-/")"   # fixed names for releases/latest/download
  done
}

release_notes() {   # notes of the release; pip installs from the release page instead of GitHub Pages
  local tag="v$VERSION" glibc; glibc=$(glibc_version)
  local assets="https://github.com/$OWNER/$REPO_ID/releases/expanded_assets/$tag"
  case "$REPO_ID" in
    msentity)
      sed "s/@VERSION@/$VERSION/g; s/@TAG@/$tag/g; s|https://motohiroogawa.github.io/msentity/|$assets|g; s/glibc ≥ 2.35/glibc ≥ $glibc/g" \
        "$REPO/.github/release-notes.md" ;;
    msentity-similarity)
      local ms; ms=$(sed -n 's/^[[:space:]]*GIT_TAG \(v[0-9.]*\)).*/\1/p' "$REPO/CMakeLists.txt")
      cat <<EOF
Packages for **Linux x64** (glibc ≥ $glibc) and **Windows x64**; requires msentity ${ms#v}.

### Python (≥ 3.10)
\`\`\`console
pip install msentity-similarity==$VERSION \\
  --find-links $assets \\
  --find-links https://github.com/$OWNER/msentity/releases/expanded_assets/$ms
\`\`\`

EOF
      ;;
    msentity-spectrum-viewer)
      sed "s/@VERSION@/$VERSION/g; s/@TAG@/$tag/g" "$REPO/.github/release-notes.md"; echo ;;
  esac
  # GitHub's list of changes since the previous release.
  gh api "repos/$OWNER/$REPO_ID/releases/generate-notes" -f tag_name="$tag" \
    -f target_commitish="$(git -C "$REPO" rev-parse HEAD)" --jq .body
}

verify() {   # install the published Python package as a user would
  local tag="v$VERSION" venv="$CACHE/verify-$REPO_ID-$VERSION"
  case "$REPO_ID" in
    msentity)
      say "Checking: pip install msentity==$VERSION from the release"
      rm -rf "$venv"; python3 -m venv "$venv"
      "$venv/bin/pip" install --quiet "msentity==$VERSION" \
        --find-links "https://github.com/$OWNER/msentity/releases/expanded_assets/$tag"
      "$venv/bin/python" -c "import importlib.metadata as m, msentity; print(m.version('msentity'), msentity.__version__)" ;;
    msentity-similarity)
      say "Checking: pip install msentity-similarity==$VERSION from the release"
      local ms; ms=$(sed -n 's/^[[:space:]]*GIT_TAG \(v[0-9.]*\)).*/\1/p' "$REPO/CMakeLists.txt")
      rm -rf "$venv"; python3 -m venv "$venv"
      "$venv/bin/pip" install --quiet "msentity-similarity==$VERSION" \
        --find-links "https://github.com/$OWNER/msentity-similarity/releases/expanded_assets/$tag" \
        --find-links "https://github.com/$OWNER/msentity/releases/expanded_assets/$ms"
      "$venv/bin/python" -c "import msentity, msentity_similarity as s; print(msentity.__version__, s.__version__)" ;;
    msentity-spectrum-viewer)
      say "Install the extension to try it:"
      info "code --install-extension $OUT/msentity-spectrum-viewer-$VERSION-linux-x64.vsix --force" ;;
  esac
  printf '\n\033[32mPublished %s %s.\033[0m\n' "$(repo_name "$REPO_ID")" "$tag"
}

# ---- abort / status ---------------------------------------------------------------------------

abort() {
  local tag; tag=$(draft_tag "$REPO_ID")
  [ -n "$tag" ] || fail "$REPO_ID has no draft release"
  if [ -n "$DRY_RUN" ]; then info "dry run: would delete the draft $tag"; return; fi
  gh release delete "$tag" --repo "$OWNER/$REPO_ID" --yes
  info "deleted the draft $tag (no tag was created). The commit \"Release ... $tag\" stays on main;"
  info "the next prepare uses the same version again."
}

status() {
  for repo in msentity msentity-similarity msentity-spectrum-viewer; do
    printf '%-26s latest %-8s draft %s\n' "$repo" "$(latest_release "$repo" 2>/dev/null || echo -)" "$(draft_tag "$repo" || true)"
  done
}

# ---- main -------------------------------------------------------------------------------------

main() {
  [ $# -ge 1 ] || usage
  COMMAND="$1"; shift
  if [ "$COMMAND" = status ]; then status; exit; fi
  [ $# -ge 1 ] || usage
  REPO_ID="$1"; shift
  repo_name "$REPO_ID" >/dev/null
  REPO="$REPOS_DIR/$REPO_ID"
  [ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || fail "$REPO is not a git repository"
  mkdir -p "$CACHE"
  case "$COMMAND" in
    prepare) prepare "$@" ;;
    publish) publish ;;
    abort) abort ;;
    *) usage ;;
  esac
}

# Run unless sourced (tests source this file to call its functions).
[ "${BASH_SOURCE[0]}" != "$0" ] || main "$@"
