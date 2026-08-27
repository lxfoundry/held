# The receiver has no dependencies, so there is no install step and no lockfile
# to drift. The image is the runtime plus four source files.

FROM node:22-alpine

# su-exec drops privileges after the entrypoint has prepared the volume, which
# is mounted root-owned.
RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
# The store lives on a mounted volume, never in the image.
ENV EVENTS_DIR=/data/events

EXPOSE 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/receiver.mjs"]
