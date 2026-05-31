FROM debian:testing

USER root
ENV DEBIAN_FRONTEND=noninteractive

ARG SVTAV1HDR_REPO=https://github.com/juliobbv-p/svt-av1-hdr.git
ARG SVTAV1HDR_REF=master

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	curl \
	git \
	build-essential \
	pkg-config \
	cmake \
	ninja-build \
	nasm \
	yasm \
	file \
	binutils \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone "${SVTAV1HDR_REPO}" svt-av1-hdr \
 && cd svt-av1-hdr \
 && git checkout "${SVTAV1HDR_REF}"

COPY build-svt-av1-hdr.sh /usr/local/bin/build-svt-av1-hdr.sh
RUN chmod +x /usr/local/bin/build-svt-av1-hdr.sh

VOLUME ["/out"]
CMD ["/usr/local/bin/build-svt-av1-hdr.sh"]