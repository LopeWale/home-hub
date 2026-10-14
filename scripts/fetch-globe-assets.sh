#!/usr/bin/env bash
# Downloads the globe library and earth textures into MMM-GlobeWeatherBridge/vendor.
# Uses `npm pack` (just the package tarball, no dependency tree) and checks
# SHA-256 of each tarball before extracting.
#
#   scripts/fetch-globe-assets.sh ~/MagicMirror/modules/MMM-GlobeWeatherBridge
set -euo pipefail

DEST="${1:?usage: fetch-globe-assets.sh <path to MMM-GlobeWeatherBridge>}"

GLOBE_GL_VERSION="2.46.2"
GLOBE_GL_SHA256="914349def3da1323fc732229c715b5be92a6fbd55346e193dc05483f72359c87"
THREE_GLOBE_VERSION="2.45.3"
THREE_GLOBE_SHA256="e5266133038d181a3a7b372a14d8ca34675f7565a6db89201cc5118d790f040e"
STAMP="globe.gl@${GLOBE_GL_VERSION} three-globe@${THREE_GLOBE_VERSION}"

if [ -f "$DEST/vendor/.stamp" ] && [ "$(cat "$DEST/vendor/.stamp")" = "$STAMP" ] && [ -f "$DEST/vendor/globe.gl.min.js" ]; then
	echo "globe assets already present ($STAMP)"
	exit 0
fi

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack --silent "globe.gl@${GLOBE_GL_VERSION}" "three-globe@${THREE_GLOBE_VERSION}" >/dev/null)

check() {
	local file="$1" want="$2" got
	got="$(sha256 "$file")"
	if [ "$got" != "$want" ]; then
		echo "checksum mismatch for $(basename "$file"): got $got, want $want" >&2
		exit 1
	fi
}
check "$tmp/globe.gl-${GLOBE_GL_VERSION}.tgz" "$GLOBE_GL_SHA256"
check "$tmp/three-globe-${THREE_GLOBE_VERSION}.tgz" "$THREE_GLOBE_SHA256"

mkdir -p "$tmp/g" "$tmp/t" "$DEST/vendor/img"
tar -xzf "$tmp/globe.gl-${GLOBE_GL_VERSION}.tgz" -C "$tmp/g" package/dist/globe.gl.min.js package/LICENSE
tar -xzf "$tmp/three-globe-${THREE_GLOBE_VERSION}.tgz" -C "$tmp/t" \
	package/example/img/earth-blue-marble.jpg package/example/img/earth-topology.png \
	package/example/img/night-sky.png package/example/img/earth-night.jpg package/LICENSE

cp "$tmp/g/package/dist/globe.gl.min.js" "$DEST/vendor/globe.gl.min.js"
cp "$tmp/g/package/LICENSE" "$DEST/vendor/LICENSE.globe.gl"
cp "$tmp/t/package/LICENSE" "$DEST/vendor/LICENSE.three-globe"
cp "$tmp/t/package/example/img/"* "$DEST/vendor/img/"
echo "$STAMP" > "$DEST/vendor/.stamp"
echo "globe assets installed: $STAMP"
