#!/bin/sh
# Installs the pinned Hugo Extended release into the container image at
# /usr/local/bin/hugo so the Node backend can build trusted Hugo templates.
#
# Scope: image build only (docker build). It requires root inside the build,
# downloads from the official gohugoio/hugo GitHub release, verifies the
# published sha256 checksum and then removes every temporary file.
# It is deliberately not a local/developer installer: it refuses to run as a
# non-root user, never uses sudo, and never reads or writes credentials.
set -eu

HUGO_VERSION="0.162.1"
RELEASE_BASE="https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}"
CHECKSUMS_NAME="hugo_${HUGO_VERSION}_checksums.txt"
CHECKSUMS_URL="${RELEASE_BASE}/${CHECKSUMS_NAME}"
INSTALL_PATH="/usr/local/bin/hugo"

log() { printf '[install-hugo] %s\n' "$*"; }
fail() {
  printf '[install-hugo] error: %s\n' "$*" >&2
  exit 1
}

# --- install target and architecture -----------------------------------------

[ "$(id -u)" = "0" ] || fail "must run as root during the image build; local installs are not supported"

detected_arch=""
if command -v dpkg >/dev/null 2>&1; then
  detected_arch="$(dpkg --print-architecture 2>/dev/null || true)"
fi
if [ -z "${detected_arch}" ] && command -v uname >/dev/null 2>&1; then
  detected_arch="$(uname -m)"
fi

# Pinned sha256 values from the official hugo_0.162.1_checksums.txt release asset.
case "${detected_arch}" in
  amd64 | x86_64)
    hugo_arch="amd64"
    pinned_sha256="e34160095b6a6406af857fe212f50e4451f67ed1276b9bb0de13d08754980118"
    ;;
  arm64 | aarch64)
    hugo_arch="arm64"
    pinned_sha256="f5531494dd573cfc142779894a9e3e414ab05626d6e0492cc06209dc783aaf39"
    ;;
  *)
    fail "unsupported architecture: ${detected_arch:-unknown} (supported: linux amd64, linux arm64)"
    ;;
esac

asset_name="hugo_extended_${HUGO_VERSION}_linux-${hugo_arch}.tar.gz"
log "target: ${asset_name} -> ${INSTALL_PATH}"

# --- temporary workspace ------------------------------------------------------

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "${tmp_dir}"; }
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

archive_path="${tmp_dir}/${asset_name}"
checksums_path="${tmp_dir}/${CHECKSUMS_NAME}"

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 30 -o "${dest}" "${url}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 30 -t 3 -O "${dest}" "${url}"
  else
    fail "curl or wget is required (install curl and ca-certificates in the image)"
  fi
}

download "${RELEASE_BASE}/${asset_name}" "${archive_path}"
download "${CHECKSUMS_URL}" "${checksums_path}"
[ -s "${archive_path}" ] || fail "downloaded archive is empty: ${asset_name}"

# --- checksum verification ----------------------------------------------------

expected_sha256="$(
  awk -v name="${asset_name}" '{ n = $2; sub(/^\*/, "", n); if (n == name) { print $1; exit } }' \
    "${checksums_path}"
)"
[ -n "${expected_sha256}" ] || fail "no checksum entry for ${asset_name} in ${CHECKSUMS_NAME}"
[ "${expected_sha256}" = "${pinned_sha256}" ] || fail \
  "checksum published for ${asset_name} is ${expected_sha256}, expected pinned ${pinned_sha256}"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "${archive_path}" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256="$(shasum -a 256 "${archive_path}" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required to verify the download"
fi

[ "${actual_sha256}" = "${expected_sha256}" ] || fail \
  "sha256 mismatch for ${asset_name}: got ${actual_sha256}, expected ${expected_sha256}"
log "sha256 verified: ${actual_sha256}"

# --- extract and install ------------------------------------------------------

tar -xzf "${archive_path}" -C "${tmp_dir}" hugo
[ -f "${tmp_dir}/hugo" ] || fail "archive did not contain the hugo binary"

if command -v install >/dev/null 2>&1; then
  install -m 0755 "${tmp_dir}/hugo" "${INSTALL_PATH}"
else
  cp "${tmp_dir}/hugo" "${INSTALL_PATH}"
  chmod 0755 "${INSTALL_PATH}"
fi

# --- sanity check -------------------------------------------------------------

installed_version="$(hugo version)"
log "${installed_version}"
case "${installed_version}" in
  *"v${HUGO_VERSION}"*) ;;
  *) fail "installed Hugo version is not v${HUGO_VERSION}: ${installed_version}" ;;
esac
case "${installed_version}" in
  *extended*) ;;
  *) fail "installed Hugo is not the extended edition: ${installed_version}" ;;
esac

log "done"
