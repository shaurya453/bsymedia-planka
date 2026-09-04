#!/usr/bin/env bash
set -euo pipefail

# Restores .env / .secrets/duckdns.env / the GitHub deploy SSH key from the
# encrypted copies committed under secrets/. gpg will prompt for the
# passphrase interactively - run this from a real terminal, not through
# automation.
#
# See README.md "Secrets management".

cd "$(dirname "$0")/.."
mkdir -p .secrets /home/deploy/.ssh

gpg --decrypt secrets/env.gpg > .env
gpg --decrypt secrets/duckdns.gpg > .secrets/duckdns.env
gpg --decrypt secrets/github_deploy_key.gpg > /home/deploy/.ssh/planka_deploy_key

chmod 600 .env .secrets/duckdns.env /home/deploy/.ssh/planka_deploy_key

echo "Restored .env, .secrets/duckdns.env, /home/deploy/.ssh/planka_deploy_key"
