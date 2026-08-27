#!/bin/sh
# A mounted volume arrives owned by root, so the directory is prepared here and
# the process then runs unprivileged. Doing it at boot rather than at build time
# is deliberate: the volume does not exist when the image is built.
set -e

EVENTS_DIR="${EVENTS_DIR:-/data/events}"

mkdir -p "$EVENTS_DIR"
chown -R node:node "$EVENTS_DIR"

exec su-exec node "$@"
