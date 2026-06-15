FROM debian:testing

USER root
ENV DEBIAN_FRONTEND=noninteractive

ARG SVTAV1ESSENTIAL_REPO=https://github.com/nekotrix/SVT-AV1-Essential.git
ARG SVTAV1ESSENTIAL_REF=v4.0.1-Essential

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

RUN git clone "${SVTAV1ESSENTIAL_REPO}" svt-av1-essential \
 && cd svt-av1-essential \
 && git checkout "${SVTAV1ESSENTIAL_REF}"

COPY build-svt-av1-essential.sh /usr/local/bin/build-svt-av1-essential.sh
RUN chmod +x /usr/local/bin/build-svt-av1-essential.sh

VOLUME ["/out"]
CMD ["/usr/local/bin/build-svt-av1-essential.sh"]