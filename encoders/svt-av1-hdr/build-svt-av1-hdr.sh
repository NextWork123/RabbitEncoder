#!/usr/bin/env bash
set -euo pipefail

SRC=/src/svt-av1-hdr
OUT=/out
mkdir -p "$OUT"

COMMON_CFLAGS="-O3 -pipe -mtune=generic"

COMMON_LDFLAGS="-static -static-libgcc -static-libstdc++"

build_one() {
  local level="$1"
  local prefix="/opt/svt-av1-hdr-${level}"

  echo "==== Building SVT-AV1-HDR for ${level} ===="

  rm -rf "$SRC/Build/linux/Release" "$SRC/Bin/Release" "$prefix"
  mkdir -p "$prefix"

  cd "$SRC/Build/linux"

  ./build.sh release static \
    --disable-native \
    --enable-lto \
    -- \
      -DCMAKE_C_FLAGS="${COMMON_CFLAGS} -march=${level}" \
      -DCMAKE_CXX_FLAGS="${COMMON_CFLAGS} -march=${level}" \
      -DCMAKE_EXE_LINKER_FLAGS="${COMMON_LDFLAGS}"

  local out_dir="$OUT/${level//-/_}"
  mkdir -p "$out_dir"
  cp "$SRC/Bin/Release/SvtAv1EncApp" "$out_dir/SvtAv1EncApp"
  strip "$out_dir/SvtAv1EncApp" || true
  chmod +x "$out_dir/SvtAv1EncApp"

  echo "---- ${level} binary info ----"
  file "$out_dir/SvtAv1EncApp" || true
  "$out_dir/SvtAv1EncApp" --version > "$out_dir/version.txt" 2>&1 || true
  cat "$out_dir/version.txt" || true

  echo "==== Done: $out_dir/SvtAv1EncApp ===="
}

build_one x86-64-v2
build_one x86-64-v3
build_one x86-64-v4

echo "All builds complete. Output tree:"
find "$OUT" -type f | sort