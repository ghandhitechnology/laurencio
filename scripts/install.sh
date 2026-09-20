#!/bin/sh
set -eu

repository="ghandhitechnology/laurencio"
version="${LAURENCIO_VERSION:-latest}"
install_dir="${LAURENCIO_INSTALL_DIR:-${HOME}/.local/bin}"

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *)
    echo "Laurencio supports macOS and Linux." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *)
    echo "Laurencio does not have a binary for this CPU." >&2
    exit 1
    ;;
esac

asset="laurencio-bun-${platform}-${arch}"
if [ "$version" = "latest" ]; then
  base_url="https://github.com/${repository}/releases/latest/download"
else
  case "$version" in
    v*) tag="$version" ;;
    *) tag="v${version}" ;;
  esac
  base_url="https://github.com/${repository}/releases/download/${tag}"
fi

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/laurencio-install.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM

curl -fL --retry 3 --output "$temp_dir/$asset" "$base_url/$asset"
curl -fL --retry 3 --output "$temp_dir/$asset.sha256" "$base_url/$asset.sha256"

if command -v shasum >/dev/null 2>&1; then
  (cd "$temp_dir" && shasum -a 256 -c "$asset.sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$temp_dir" && sha256sum -c "$asset.sha256")
else
  echo "A SHA-256 checker is required (shasum or sha256sum)." >&2
  exit 1
fi

mkdir -p "$install_dir"
if [ -f "$install_dir/laurencio" ]; then
  cp "$install_dir/laurencio" "$install_dir/laurencio.previous"
fi
install -m 755 "$temp_dir/$asset" "$install_dir/laurencio"

echo "Installed Laurencio to $install_dir/laurencio"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) echo "Add $install_dir to PATH, then run: laurencio init" ;;
esac
