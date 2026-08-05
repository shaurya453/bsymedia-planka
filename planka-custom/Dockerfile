# Thin wrapper around upstream PLANKA that adds a small floating "Invite
# users" link to invite-service (/invite/), since PLANKA has no native
# invite feature and no plugin/customization hook to add one (confirmed
# against live source - no CUSTOM_HTML/menu/link config in config/custom.js).
#
# Patches only /app/views/index.ejs (the server-rendered HTML shell PLANKA
# serves on every request) - not the compiled React bundle, which is
# reverse-engineered/minified and would be far too fragile to patch.
#
# On every PLANKA version bump: re-check that index.ejs still contains the
# `<div id="root"></div>` anchor line below before assuming this still works.
FROM ghcr.io/plankanban/planka:2.1.1

# Upstream runs as the non-root `node` user; switch to root just for this
# patch step, then switch back so the container still runs unprivileged.
USER root
COPY invite-button.html /tmp/invite-button.html
RUN sed -i -e '/<div id="root"><\/div>/r /tmp/invite-button.html' /app/views/index.ejs \
    && rm /tmp/invite-button.html
USER node
