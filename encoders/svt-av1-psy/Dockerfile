FROM debian:testing

USER root
ENV DEBIAN_FRONTEND=noninteractive

ARG SVTAV1PSY_REPO=https://github.com/5fish/svt-av1-psy.git

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	curl \
	git \
	build-essential \
	clang \
	lld \
	llvm \
	pkg-config \
	cmake \
	ninja-build \
	nasm \
	yasm \
	file \
	binutils \
	&& rm -rf /var/lib/apt/lists/*

# clang's PGO-generate phase links the compiler-rt profile runtime
# (libclang_rt.profile.a), which ships in a separate, version-matched package
# that clang/llvm don't pull in on their own.
RUN apt-get update \
 && CLANG_MAJOR="$(clang --version | sed -nE 's/.*version ([0-9]+).*/\1/p' | head -n1)" \
 && apt-get install -y --no-install-recommends "libclang-rt-${CLANG_MAJOR}-dev" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone "${SVTAV1PSY_REPO}" svt-av1-psy \
 && cd svt-av1-psy

COPY build-svt-av1-psy.sh /usr/local/bin/build-svt-av1-psy.sh
RUN chmod +x /usr/local/bin/build-svt-av1-psy.sh

VOLUME ["/out"]
CMD ["/usr/local/bin/build-svt-av1-psy.sh"]