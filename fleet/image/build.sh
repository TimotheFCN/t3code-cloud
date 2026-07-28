#!/usr/bin/env bash
# Builds (and optionally pushes) the t3env base image.
#
# Usage:
#   ./build.sh                          # build t3env:dev locally
#   TAG=0.0.29 ./build.sh               # build t3env:0.0.29
#   REGISTRY=registry.lan:5000 TAG=0.0.29 PUSH=1 ./build.sh
#
# Environment:
#   REGISTRY   optional registry prefix (default: none — local image only)
#   IMAGE_NAME image name               (default: t3env)
#   TAG        image tag                (default: dev)
#   PUSH       "1" to push after build  (default: 0)
#
# No secrets are required to build. Version pins live in the Dockerfile as
# ARGs; override any of them with e.g. BUILD_ARGS="--build-arg T3_VERSION=x".
set -euo pipefail

cd "$(dirname "$0")"

IMAGE_NAME="${IMAGE_NAME:-t3env}"
TAG="${TAG:-dev}"
REGISTRY="${REGISTRY:-}"
PUSH="${PUSH:-0}"

reference="${IMAGE_NAME}:${TAG}"
if [ -n "${REGISTRY}" ]; then
  reference="${REGISTRY}/${reference}"
fi

revision="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"

# shellcheck disable=SC2086 — BUILD_ARGS is intentionally word-split
docker build \
  --build-arg "T3ENV_IMAGE_REVISION=${revision}" \
  ${BUILD_ARGS:-} \
  -t "${reference}" \
  .

echo "built ${reference}"

if [ "${PUSH}" = "1" ]; then
  docker push "${reference}"
  echo "pushed ${reference}"
fi
