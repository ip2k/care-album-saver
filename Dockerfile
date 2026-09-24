# Two stages. The build stage copies in the build context — whatever .dockerignore lets
# through — installs every dependency, the dev ones included, and compiles. The runtime stage
# starts again from the base image and takes across only what runs: the compiled dist/, the
# package's own package.json, the AppleScript, the LICENSE and the production node_modules.
# So the published image carries no src/, no test files (two of which hold deliberately fake
# sessions and signed URLs) and no build tooling (security review sc-7).
#
# What that does NOT do: the build stage's layers still hold everything the context carried.
# They are not part of the published image, but they stay in the build cache of the machine
# that built it, `docker build --target build` makes an image of them, and a runtime COPY
# widened again would carry them forward. .dockerignore is what keeps a session out of the
# build in the first place — see SECURITY.md.
FROM node:22-slim AS build
WORKDIR /app
# pnpm at exactly the version CI runs (.github/workflows/*.yml; test/workflows.test.js keeps
# the two equal). Given no version, corepack asks the registry for the latest pnpm, so two
# builds of one commit could install with two different ones (security review sc-6).
RUN corepack enable && corepack install -g pnpm@12.5.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY packages/care-album-saver/package.json packages/care-album-saver/
# Exactly the locked versions, and no dependency's install scripts: none of them needs one,
# and building an image is no reason to run code from the registry.
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
# Only what runs, each named (test/dockerfile.test.js refuses anything else). node_modules is
# the production set `pnpm prune --prod` left: the store at the root, and the package's own
# links into it, which are relative and so resolve here as they did there.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/care-album-saver/node_modules ./packages/care-album-saver/node_modules
COPY --from=build /app/packages/care-album-saver/dist ./packages/care-album-saver/dist
COPY --from=build /app/packages/care-album-saver/applescript ./packages/care-album-saver/applescript
COPY --from=build /app/packages/care-album-saver/package.json /app/packages/care-album-saver/LICENSE ./packages/care-album-saver/
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
