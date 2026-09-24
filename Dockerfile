# Multi-stage so that build tooling does not reach the published image. Note what this
# does NOT do: the build stage copies the build context in, so anything sitting in the
# context is in the image's history whether or not the runtime stage copies it forward.
# .dockerignore is what keeps a session out — see SECURITY.md.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages/care-album-saver/package.json packages/care-album-saver/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages ./packages
RUN pnpm build && pnpm prune --prod

FROM node:22-slim AS runtime
# This line is here for Perl, not for the distro's ExifTool. metadata.ts and verify.ts only
# ever import `exiftool-vendored`, whose bundled ExifTool is a Perl script that it runs with
# /usr/bin/perl — so the package's own /usr/bin/exiftool is never run. But node:22-slim
# ships only perl-base, which has no Time::Local, and without that module ExifTool skips
# the QuickTime movie, track and media dates of every video: it prints a warning, reports
# the file as updated and exits 0, so the tool believes the dates are in when the container
# still carries the encoder's. libimage-exiftool-perl pulls in full perl, which has it.
#
# A slimmer alternative is `perl` alone (perl-modules-5.36 is what carries Time::Local). If
# that is ever tried, write the QuickTime dates into an MP4 inside the built image and read
# them back before trusting it; a run that merely succeeds proves nothing here.
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
