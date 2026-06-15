FROM debian:testing

USER root
ENV DEBIAN_FRONTEND=noninteractive

ARG SVTAV1PSY_REPO=https://github.com/5fish/svt-av1-psy.git

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

RUN git clone "${SVTAV1PSY_REPO}" svt-av1-psy \
 && cd svt-av1-psy

COPY build-svt-av1-psy.sh /usr/local/bin/build-svt-av1-psy.sh
RUN chmod +x /usr/local/bin/build-svt-av1-psy.sh

VOLUME ["/out"]
CMD ["/usr/local/bin/build-svt-av1-psy.sh"]