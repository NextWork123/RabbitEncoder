#!/bin/sh
set -e

BIN_DIR="/app/binaries"
TARGET="/usr/local/bin/SvtAv1EncApp"

if ! command -v SvtAv1EncApp >/dev/null 2>&1; then
    echo "[entrypoint] SvtAv1EncApp not installed, detecting CPU..."

    SUPPORTS_V3=0

    # Preferred: ask the dynamic loader (glibc 2.33+ prints supported subarchs)
    if /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 --help 2>/dev/null \
        | grep -q 'x86-64-v3 (supported, searched)'; then
        SUPPORTS_V3=1
    else
        # Fallback: check CPU flags directly. x86-64-v3 requires all of these.
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
        echo "[entrypoint] CPU supports x86-64-v3 -> using SvtAv1EncApp_Optimized"
        ln -sf "$BIN_DIR/SvtAv1EncApp_Optimized" "$TARGET"
    else
        echo "[entrypoint] CPU does not support x86-64-v3 -> using SvtAv1EncApp_Generic"
        ln -sf "$BIN_DIR/SvtAv1EncApp_Generic" "$TARGET"
    fi
fi

exec "$@"