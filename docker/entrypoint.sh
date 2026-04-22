#!/bin/sh
set -e

BIN_DIR="/app/binaries"
TARGET_BIN="/usr/local/bin/SvtAv1EncApp"
TARGET_LIB="/usr/lib/x86_64-linux-gnu/vapoursynth/libvszip.so"

# Always expose the arch-independent language-detector
if ! command -v language-detector >/dev/null 2>&1; then
	ln -sf "$BIN_DIR/language-detector" /usr/local/bin/language-detector
fi

if ! command -v SvtAv1EncApp >/dev/null 2>&1; then
	echo "[entrypoint] Detecting CPU..."

	SUPPORTS_V3=0

	# Preferred: ask the dynamic loader
	if /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 --help 2>/dev/null \
		| grep -q 'x86-64-v3 (supported, searched)'; then
		SUPPORTS_V3=1
	else
		# Fallback: check CPU flags directly
		FLAGS=$(grep -m1 '^flags' /proc/cpuinfo | cut -d: -f2-)
		MISSING=""
		for f in avx avx2 bmi1 bmi2 f16c fma lzcnt movbe; do
			case " $FLAGS " in
				*" $f "*) ;;
				*) MISSING="$MISSING $f" ;;
			esac
		done
		[ -z "$MISSING" ] && SUPPORTS_V3=1
	fi

	if [ "$SUPPORTS_V3" -eq 1 ]; then
		ARCH_DIR="$BIN_DIR/x86_64_v3"
		echo "[entrypoint] CPU supports x86-64-v3"
	else
		ARCH_DIR="$BIN_DIR/x86_64_v2"
		echo "[entrypoint] CPU supports x86-64-v2"
	fi

	ln -sf "$ARCH_DIR/SvtAv1EncApp" "$TARGET_BIN"
	ln -sf "$ARCH_DIR/libvszip.so"  "$TARGET_LIB"

	# Refresh the dynamic linker cache so libvszip.so is findable
	ldconfig 2>/dev/null || true
fi

exec "$@"