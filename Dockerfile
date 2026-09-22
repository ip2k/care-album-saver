# Multi-stage so that build tooling — and anything that might be sitting in the build
# context — never reaches the published image.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages/media-ferry/package.json packages/media-ferry/
COPY packages/brightwheel-archive/package.json packages/brightwheel-archive/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages ./packages
RUN pnpm build && pnpm prune --prod

FROM node:22-slim AS runtime
# ExifTool from the distro rather than the vendored npm package: it is smaller, it is
# patched by the distro's security updates, and it avoids a native postinstall step.
RUN apt-get update && apt-get install -y --no-install-recommends libimage-exiftool-perl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
# The mount points must exist and belong to `node` before the volumes are declared. A
# VOLUME path that is absent from the image is created at container start as root:root,
# which the unprivileged user below cannot write — so a named volume would fail on the
# first mkdir. A host folder bind-mounted here keeps the host's ownership instead, so on
# a Linux host the container must run as that owner: `docker run --user "$(id -u):$(id -g)"`.
# The `node` user is uid 1000; a host user who is also 1000 needs nothing extra, and
# Docker Desktop on macOS and Windows maps bind mounts to whoever asks.
RUN mkdir -p /config /photos && chown node:node /config /photos
# Run as an unprivileged user. The `node` user ships with the base image.
USER node
ENV BRIGHTWHEEL_ARCHIVE_CONFIG_DIR=/config
VOLUME ["/config", "/photos"]
ENTRYPOINT ["node", "packages/brightwheel-archive/dist/cli.js"]
CMD ["run", "--dir", "/photos"]
