# t3env — the T3 Fleet base image for environment containers.
#
# One environment container = one full Linux workspace running one T3 server,
# with an inner Docker daemon (requires the sysbox runtime on the node) and
# the provider CLIs on PATH. Keep contents boring and pinned: every binary
# version is an explicit ARG below; updating a dependency is a one-line bump.
#
# Durability contract (docs/fleet/architecture.md — Image Updates): the
# environment volume is mounted at /root. Everything under /root survives
# recreates; everything else is legitimately lost. For that reason every
# binary here installs outside /root (/usr/local), otherwise the persisted
# volume would shadow updated tools after an image update.

ARG UBUNTU_VERSION=24.04
FROM ubuntu:${UBUNTU_VERSION}

ARG NODE_VERSION=24.13.1
ARG T3_VERSION=0.0.29
ARG CODEX_VERSION=0.145.0
ARG CLAUDE_CODE_VERSION=2.1.220
ARG OPENCODE_VERSION=1.18.8
ARG CURSOR_AGENT_VERSION=2026.07.23-e383d2b
ARG TAILSCALE_VERSION=1.98.9
ARG GH_VERSION=2.96.0
# Debian package version strings for the Docker Engine apt repo (noble).
ARG DOCKER_APT_VERSION=5:29.6.2-1~ubuntu.24.04~noble
ARG CONTAINERD_APT_VERSION=2.2.6-1~ubuntu.24.04~noble
ARG DOCKER_BUILDX_APT_VERSION=0.35.0-1~ubuntu.24.04~noble
ARG DOCKER_COMPOSE_APT_VERSION=5.3.1-1~ubuntu.24.04~noble

ENV DEBIAN_FRONTEND=noninteractive

# Base tooling from the Ubuntu archive (pinned transitively by the base image).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    gnupg \
    iproute2 \
    iptables \
    jq \
    less \
    openssh-client \
    procps \
    python3 \
    ripgrep \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Docker Engine: the *inner* daemon plus CLI, buildx, and compose. sysbox is
# what lets dockerd run in an unprivileged container; the node provides the
# runtime, this image provides the binaries.
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
  && . /etc/os-release \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    "docker-ce=${DOCKER_APT_VERSION}" \
    "docker-ce-cli=${DOCKER_APT_VERSION}" \
    "containerd.io=${CONTAINERD_APT_VERSION}" \
    "docker-buildx-plugin=${DOCKER_BUILDX_APT_VERSION}" \
    "docker-compose-plugin=${DOCKER_COMPOSE_APT_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

# Node (official tarball into /usr/local; matches upstream engines.node).
RUN arch="$(dpkg --print-architecture)" \
  && case "${arch}" in \
    amd64) node_arch=x64 ;; \
    arm64) node_arch=arm64 ;; \
    *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
  && rm /tmp/node.tar.xz \
  && node --version

# GitHub CLI (release deb, pinned).
RUN arch="$(dpkg --print-architecture)" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.deb" -o /tmp/gh.deb \
  && apt-get install -y /tmp/gh.deb \
  && rm /tmp/gh.deb \
  && gh --version

# Tailscale (static tarball, pinned). Joined in fleet phase 4; the state
# directory will live on the environment volume.
RUN arch="$(dpkg --print-architecture)" \
  && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${arch}.tgz" -o /tmp/tailscale.tgz \
  && tar -xzf /tmp/tailscale.tgz -C /tmp \
  && install -m 0755 "/tmp/tailscale_${TAILSCALE_VERSION}_${arch}/tailscale" /usr/local/bin/tailscale \
  && install -m 0755 "/tmp/tailscale_${TAILSCALE_VERSION}_${arch}/tailscaled" /usr/local/sbin/tailscaled \
  && rm -rf /tmp/tailscale.tgz "/tmp/tailscale_${TAILSCALE_VERSION}_${arch}" \
  && tailscale version

# The T3 server and the npm-distributed provider CLIs, all pinned.
RUN npm install -g --no-fund --no-audit \
    "t3@${T3_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "opencode-ai@${OPENCODE_VERSION}" \
  && npm cache clean --force

# Cursor CLI (versioned tarball, same URL the official installer uses).
RUN arch="$(dpkg --print-architecture)" \
  && case "${arch}" in \
    amd64) cursor_arch=x64 ;; \
    arm64) cursor_arch=arm64 ;; \
    *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
  esac \
  && mkdir -p /usr/local/share/cursor-agent \
  && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${cursor_arch}/agent-cli-package.tar.gz" \
    | tar -xzf - -C /usr/local/share/cursor-agent --strip-components=1 \
  && ln -sf /usr/local/share/cursor-agent/cursor-agent /usr/local/bin/cursor-agent

# Inner Docker keeps its data root on the environment volume so inner images,
# containers, and volumes survive container recreates.
COPY daemon.json /etc/docker/daemon.json
COPY entrypoint.sh /usr/local/bin/t3env-entrypoint
RUN chmod 0755 /usr/local/bin/t3env-entrypoint

# T3 server defaults; the fleet controller overrides these per environment.
ENV T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3773 \
    T3CODE_HOME=/root/.t3 \
    T3CODE_NO_BROWSER=1

ARG T3ENV_IMAGE_REVISION=dev
LABEL org.opencontainers.image.title="t3env" \
    org.opencontainers.image.description="T3 Fleet environment: T3 Code server, provider CLIs, inner Docker, Tailscale" \
    org.opencontainers.image.revision="${T3ENV_IMAGE_REVISION}" \
    dev.t3fleet.node-version="${NODE_VERSION}" \
    dev.t3fleet.t3-version="${T3_VERSION}" \
    dev.t3fleet.codex-version="${CODEX_VERSION}" \
    dev.t3fleet.claude-code-version="${CLAUDE_CODE_VERSION}" \
    dev.t3fleet.opencode-version="${OPENCODE_VERSION}" \
    dev.t3fleet.cursor-agent-version="${CURSOR_AGENT_VERSION}" \
    dev.t3fleet.tailscale-version="${TAILSCALE_VERSION}"

WORKDIR /root
EXPOSE 3773
ENTRYPOINT ["/usr/local/bin/t3env-entrypoint"]
