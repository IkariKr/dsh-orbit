ARG NODE_IMAGE=node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
FROM ${NODE_IMAGE}

ARG DSH_VERSION=0.1.1-rc.2
ARG DSH_PUBLIC_HOST
ARG PNPM_VERSION=10.15.0

RUN test -n "$DSH_PUBLIC_HOST"

RUN apk add --no-cache \
      bash \
      ca-certificates \
      curl \
      git \
      python3 \
      py3-pip \
      py3-virtualenv \
    && update-ca-certificates \
    && addgroup -S -g 10001 dsh \
    && adduser -S -D -H -s /bin/bash -u 10001 -G dsh dsh \
    && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}"

ENV DSH_HOME=/data/dsh-home
ENV HOME=/data/dsh-home
ENV SHELL=/bin/bash
ENV DSH_PUBLIC_HOST=${DSH_PUBLIC_HOST}
ENV DSH_PROXY_AUTH_FILE=/run/secrets/dsh_proxy_auth
ENV DSH_PROFILE_ROOT=/data/dsh-home/profiles/web
ENV DSH_ORBIT_HOOK_DIR=/opt/dsh-orbit/hooks

COPY src/ /usr/local/lib/dsh-orbit/src/
COPY bin/ /usr/local/lib/dsh-orbit/bin/
COPY docker/start.sh /usr/local/bin/dsh-orbit-start
COPY bin/dsh-orbit-restart-web /usr/local/bin/dsh-restart-web

RUN node /usr/local/lib/dsh-orbit/bin/dsh-orbit-patch.mjs --build \
    && chmod 0755 /usr/local/bin/dsh-orbit-start /usr/local/bin/dsh-restart-web

WORKDIR /workspace
USER 10001:10001

ENTRYPOINT ["/usr/local/bin/dsh-orbit-start"]
