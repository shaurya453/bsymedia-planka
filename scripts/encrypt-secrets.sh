#!/usr/bin/env bash
set -euo pipefail

# Regenerates secrets/*.enc.* from the live plaintext secrets on this box,
# encrypted to the "PLANKA Secrets" GPG key. Only needs that key's PUBLIC
# half, so this runs without the passphrase. Run this after rotating any
# value in .env / .secrets/duckdns.env / the GitHub deploy SSH key, then
# `git diff secrets/` to sanity-check and commit.
#
# See README.md "Secrets management" for the full picture (key generation,
# where the passphrase/private-key backup live, disaster recovery).

FPR=BF1F9D2C001719E61DC2AD66C74FDCF778435A45

cd "$(dirname "$0")/.."
mkdir -p secrets

sops --config /dev/null --pgp "$FPR" --input-type dotenv --output-type dotenv \
  -e .env > secrets/env.enc.env

sops --config /dev/null --pgp "$FPR" --input-type dotenv --output-type dotenv \
  -e .secrets/duckdns.env > secrets/duckdns.enc.env

sops --config /dev/null --pgp "$FPR" --input-type binary --output-type json \
  -e ~/.ssh/planka_deploy_key > secrets/github_deploy_key.enc.json

echo "Wrote secrets/env.enc.env, secrets/duckdns.enc.env, secrets/github_deploy_key.enc.json"
echo "Review with 'git diff secrets/' before committing."
