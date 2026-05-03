#!/bin/sh
set -e

BIN_DIR="/app/binaries"

TARGET_SVT="/usr/local/bin/SvtAv1EncApp"
TARGET_FFMPEG="/usr/local/bin/ffmpeg"
TARGET_FFPROBE="/usr/local/bin/ffprobe"

TARGET_LIB="/usr/lib/x86_64-linux-gnu/vapoursynth/libvszip.so"

# Always expose the arch-independent language-detector
if ! command -v language-detector >/dev/null 2>&1; then
	ln -sf "$BIN_DIR/language-detector" /usr/local/bin/language-detector
fi

echo "[entrypoint] Detecting CPU..."

SUPPORTS_V4=0
SUPPORTS_V3=0

# Preferred: ask the dynamic loader
if /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 --help 2>/dev/null \
	| grep -q 'x86-64-v4 (supported, searched)'; then
	SUPPORTS_V4=1
elif /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 --help 2>/dev/null \
	| grep -q 'x86-64-v3 (supported, searched)'; then
	SUPPORTS_V3=1
else
	# Fallback: check CPU flags directly
	FLAGS=$(grep -m1 '^flags' /proc/cpuinfo | cut -d: -f2- || true)
	MISSING_V4=""
	MISSING_V3=""

	# Check x86-64-v4 features
	for f in avx512f avx512bw avx512cd avx512dq avx512vl; do
		case " $FLAGS " in
			*" $f "*) ;;
			*) MISSING_V4="$MISSING_V4 $f" ;;
		esac
	done
	[ -z "$MISSING_V4" ] && SUPPORTS_V4=1

	if [ "$SUPPORTS_V4" -eq 0 ]; then
		# Check x86-64-v3 features
		for f in avx avx2 bmi1 bmi2 f16c fma lzcnt movbe; do
			case " $FLAGS " in
				*" $f "*) ;;
				*) MISSING_V3="$MISSING_V3 $f" ;;
			esac
		done
		[ -z "$MISSING_V3" ] && SUPPORTS_V3=1
	fi
fi

if [ "$SUPPORTS_V4" -eq 1 ]; then
	ARCH_NAME="x86-64-v4"
	ARCH_DIR="$BIN_DIR/x86_64_v4"
	FFMPEG_DIR="/opt/ffmpeg-x86-64-v4"
	echo "[entrypoint] CPU supports x86-64-v4"
elif [ "$SUPPORTS_V3" -eq 1 ]; then
	ARCH_NAME="x86-64-v3"
	ARCH_DIR="$BIN_DIR/x86_64_v3"
	FFMPEG_DIR="/opt/ffmpeg-x86-64-v3"
	echo "[entrypoint] CPU supports x86-64-v3"
else
	ARCH_NAME="x86-64-v2"
	ARCH_DIR="$BIN_DIR/x86_64_v2"
	FFMPEG_DIR="/opt/ffmpeg-x86-64-v2"
	echo "[entrypoint] CPU supports x86-64-v2"
fi

# Expose SVT-AV1 encoder
if [ -x "$ARCH_DIR/SvtAv1EncApp" ]; then
	ln -sf "$ARCH_DIR/SvtAv1EncApp" "$TARGET_SVT"
fi

# Expose VapourSynth zip plugin
if [ -f "$ARCH_DIR/libvszip.so" ]; then
	ln -sf "$ARCH_DIR/libvszip.so" "$TARGET_LIB"
fi

# Expose custom FFmpeg
if [ -x "$FFMPEG_DIR/bin/ffmpeg" ]; then
	ln -sf "$FFMPEG_DIR/bin/ffmpeg" "$TARGET_FFMPEG"
else
	echo "[entrypoint] ERROR: missing $FFMPEG_DIR/bin/ffmpeg" >&2
	exit 1
fi

if [ -x "$FFMPEG_DIR/bin/ffprobe" ]; then
	ln -sf "$FFMPEG_DIR/bin/ffprobe" "$TARGET_FFPROBE"
else
	echo "[entrypoint] ERROR: missing $FFMPEG_DIR/bin/ffprobe" >&2
	exit 1
fi

# Make matching FFmpeg shared libs visible
export LD_LIBRARY_PATH="$FFMPEG_DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# Refresh the dynamic linker cache so libvszip.so is findable
ldconfig 2>/dev/null || true

echo "[entrypoint] Using FFmpeg: $("$TARGET_FFMPEG" -hide_banner -version | head -n1)"
echo "[entrypoint] Using FFprobe: $("$TARGET_FFPROBE" -hide_banner -version | head -n1)"

exec "$@"