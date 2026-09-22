# Multi-stage so that build tooling does not reach the published image. Note what this
# does NOT do: the build stage copies the build context in, so anything sitting in the
# context is in the image's history whether or not the runtime stage copies it forward.
# .dockerignore is what keeps a session out — see SECURITY.md.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages/media-ferry/package.json packages/media-ferry/
COPY packages/care-album-saver/package.json packages/care-album-saver/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages ./packages
RUN pnpm build && pnpm prune --prod

FROM node:22-slim AS runtime
# ExifTool from the distro: smaller than the vendored npm package, patched by the distro's
# security updates, and no native postinstall step.
#
# It is NOT currently reached: metadata.ts imports the `exiftool-vendored` package, which
# carries its own binary, so a run in this image embeds metadata only if that optional
# dependency installed. Kept because the alternative — dropping it — would leave the image
# with no ExifTool at all if the vendored package is ever made non-optional or fails to
# install, and because a system-ExifTool path is the obvious way to slim this image later.
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
ENV CARE_ALBUM_CONFIG_DIR=/config
VOLUME ["/config", "/photos"]
ENTRYPOINT ["node", "packages/care-album-saver/dist/cli.js"]
CMD ["run", "--dir", "/photos"]
