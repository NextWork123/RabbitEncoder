# Build stage

FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json ./
RUN bun install

COPY src/ ./src/
COPY public/ ./public/

RUN bun build src/index.ts --outfile rabbit-encoder --target bun --compile --production

# Runtime stage
FROM debian:13-slim

USER root
ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTICL_ENABLE=radeonsi,iris,nouveau

# Install packages
RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		gpgv \
	&& rm -rf /var/lib/apt/lists/*

# Install deb-multimedia keyring
RUN curl -fsSLo /tmp/deb-multimedia-keyring.deb \
    https://www.deb-multimedia.org/pool/main/d/deb-multimedia-keyring/deb-multimedia-keyring_2024.9.1_all.deb \
 && dpkg -i /tmp/deb-multimedia-keyring.deb \
 && rm -f /tmp/deb-multimedia-keyring.deb

RUN cat >/etc/apt/sources.list.d/dmo.sources <<'EOF'
Types: deb
URIs: https://www.deb-multimedia.org
Suites: trixie
Components: main non-free
Signed-By: /usr/share/keyrings/deb-multimedia-keyring.pgp
Enabled: yes
EOF

# Install packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    vapoursynth \
    python3-vapoursynth-jetpack \
    vapoursynth-akarin \
    vapoursynth-ffms2 \
    ffmpeg \
    mediainfo \
    opus-tools \
    mkvtoolnix \
		ocl-icd-libopencl1 \
		mesa-opencl-icd \
		clinfo \
 && pip3 install --no-cache-dir --break-system-packages --no-deps vstools \
#&& rm -f /etc/OpenCL/vendors/mesa.icd \
 && rm -rf /var/lib/apt/lists/*

# Copy binaries
COPY binaries/ /app/binaries/
RUN chmod +x /app/binaries/language-detector /app/binaries/x86_64_v2/SvtAv1EncApp /app/binaries/x86_64_v3/SvtAv1EncApp

# Entrypoint
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Auto-Boost-Essential script
RUN mkdir -p /opt/Auto-Boost-Essential
COPY scripts/Auto-Boost-Essential.py /opt/Auto-Boost-Essential/

# Application
WORKDIR /app

COPY --from=builder /app/rabbit-encoder /app/

RUN mkdir -p /data/input /data/output /data/temp

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/app/rabbit-encoder"]