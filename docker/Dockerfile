FROM node:22-alpine

ARG DSH_VERSION=0.1.1-rc.2
ARG DSH_PUBLIC_HOST

RUN test -n "$DSH_PUBLIC_HOST"

RUN apk add --no-cache \
      bash \
      ca-certificates \
      curl \
      git \
      python3 \
    && update-ca-certificates \
    && addgroup -S -g 10001 dsh \
    && adduser -S -D -H -u 10001 -G dsh dsh \
    && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

ENV DSH_HOME=/data/dsh-home
ENV HOME=/data/dsh-home
ENV DSH_PUBLIC_HOST=${DSH_PUBLIC_HOST}
ENV DSH_PROXY_AUTH_FILE=/run/secrets/dsh_proxy_auth
ENV DSH_PROFILE_ROOT=/data/dsh-home/profiles/web

COPY src/ /usr/local/lib/dsh-orbit/src/
COPY bin/ /usr/local/lib/dsh-orbit/bin/
COPY docker/start.sh /usr/local/bin/dsh-orbit-start

RUN node /usr/local/lib/dsh-orbit/bin/dsh-orbit-patch.mjs --build \
    && chmod 0755 /usr/local/bin/dsh-orbit-start

WORKDIR /workspace
USER 10001:10001

ENTRYPOINT ["/usr/local/bin/dsh-orbit-start"]
