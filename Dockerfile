# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0-alpine AS build

WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) bun_arch=x64 ;; \
      arm64) bun_arch=arm64 ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && bun build \
      --compile \
      --minify \
      --target="bun-linux-${bun_arch}-musl" \
      --outfile=/out/dlog \
      src/index.ts

FROM alpine:3.22

RUN apk add --no-cache libstdc++ tzdata \
    && addgroup -S dlog \
    && adduser -S -G dlog -h /home/dlog dlog \
    && mkdir -p /vault \
    && chown dlog:dlog /vault

COPY --from=build --chown=dlog:dlog /out/dlog /usr/local/bin/dlog
RUN ln -s dlog /usr/local/bin/dlog-append \
    && ln -s dlog /usr/local/bin/dlog-fixup \
    && ln -s dlog /usr/local/bin/dlog-tail

ENV HOME=/home/dlog
WORKDIR /vault
USER dlog

ENTRYPOINT ["/usr/local/bin/dlog"]
CMD ["fixup", "--watch"]
