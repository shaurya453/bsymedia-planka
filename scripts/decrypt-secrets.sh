#!/usr/bin/env bash
set -euo pipefail

# Restores .env / .secrets/duckdns.env / the GitHub deploy SSH key from the
# encrypted copies committed under secrets/. Requires the "PLANKA Secrets"
# GPG private key to be imported into this machine's keyring and its
# passphrase entered when gpg-agent prompts (interactive - run this from a
# real terminal, not through automation).
#
# See README.md "Secrets management" for how to import the key on a fresh
# box (from the off-VM backup) before running this.

cd "$(dirname "$0")/.."
mkdir -p .secrets ~/.ssh

sops --config /dev/null --input-type dotenv --output-type dotenv \
  -d secrets/env.enc.env > .env

sops --config /dev/null --input-type dotenv --output-type dotenv \
  -d secrets/duckdns.enc.env > .secrets/duckdns.env

sops --config /dev/null --input-type json --output-type binary \
  -d secrets/github_deploy_key.enc.json > ~/.ssh/planka_deploy_key

chmod 600 .env .secrets/duckdns.env ~/.ssh/planka_deploy_key

echo "Restored .env, .secrets/duckdns.env, ~/.ssh/planka_deploy_key"
