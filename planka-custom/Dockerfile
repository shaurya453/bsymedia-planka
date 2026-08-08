# Fork-and-build image for BSY Media's PLANKA customizations.
#
# Replaces the old "pull the prebuilt ghcr.io/plankanban/planka image and
# sed-patch index.ejs" approach: those UI changes (add-list edit-mode
# default, share button, smart background theming, preset background
# gallery) touch the compiled React bundle, which can't be patched safely
# after the fact. Instead we clone PLANKA's own source at the exact tag
# this instance runs, apply a small isolated patch set on top, and run
# PLANKA's own build pipeline (mirrored from its own Dockerfile) unchanged.
#
# On every PLANKA version bump: bump PLANKA_VERSION below, re-run
# `git apply --check patches/*.patch` against the new tag before building,
# and re-diff/rebase any patch that no longer applies cleanly.
ARG PLANKA_VERSION=2.1.1

# Stage 0: fetch upstream source and apply our patch set once, shared by
# both the server and client build stages below.
FROM alpine/git:2.45.2 AS source

ARG PLANKA_VERSION
WORKDIR /src

RUN git clone --branch "${PLANKA_VERSION}" --depth 1 \
      https://github.com/plankanban/planka.git .

COPY patches/ /patches/
RUN for patch in /patches/*.patch; do \
      echo "Applying $patch"; \
      git apply --binary "$patch" || exit 1; \
    done

# Stage 1: Server build (mirrors upstream's own Dockerfile)
FROM node:24-alpine AS server

RUN apk -U upgrade \
  && apk add build-base python3 --no-cache

WORKDIR /app

COPY --from=source /src/server .

RUN  npm install \
  && npm run build \
  && npm prune --production

# Stage 2: Client build (mirrors upstream's own Dockerfile)
FROM node:24 AS client

WORKDIR /app

COPY --from=source /src/client .

RUN npm install npm --global \
  && npm install --omit=dev \
  && INDEX_FORMAT=ejs DISABLE_ESLINT_PLUGIN=true npm run build

# Stage 3: Final image (mirrors upstream's own Dockerfile, plus our
# invite-service link patch and custom terms content)
FROM node:24-alpine

RUN apk -U upgrade \
  && apk add bash python3 squid --no-cache

USER node
WORKDIR /app

COPY --from=source --chown=node:node /src/LICENSE.md .
COPY --from=source --chown=node:node ["/src/LICENSES/PLANKA Community License DE.md", "LICENSE_DE.md"]

COPY --from=server --chown=node:node /app/node_modules node_modules
COPY --from=server --chown=node:node /app/dist .

COPY --from=client --chown=node:node /app/dist public

RUN python3 -m venv .venv \
  && .venv/bin/pip3 install --upgrade pip \
  && .venv/bin/pip3 install -r requirements.txt --no-cache-dir \
  && mv .env.sample .env \
  && mv public/index.ejs views \
  && npm config set update-notifier false

# BSY Media: real Terms of Service content (TERMS_TYPE defaults to
# "custom" upstream; without this file it silently falls back to the
# "THIS IS ONLY A TEMPLATE" placeholder).
USER root
COPY --chown=node:node terms/custom /app/terms/custom
USER node

VOLUME /app/data
EXPOSE 1337

HEALTHCHECK --interval=10s --timeout=2s --start-period=15s \
  CMD node ./healthcheck.js

CMD ["./start.sh"]
