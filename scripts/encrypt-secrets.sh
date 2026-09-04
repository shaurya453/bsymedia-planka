#!/usr/bin/env bash
set -euo pipefail

# Re-encrypts secrets/*.gpg from the live plaintext secrets on this box.
# Plain passphrase encryption (gpg --symmetric, AES256) - no keypair, no
# separate key file to back up. gpg will prompt you for the passphrase
# interactively (twice, to confirm); use the same one you use for the
# Mega/rclone backup so there's only one password to remember for restore.
#
# Run this yourself after rotating anything in .env / .secrets/duckdns.env
# / the GitHub deploy SSH key, then `git add secrets/ && git commit`.
#
# See README.md "Secrets management" for the full picture.

cd "$(dirname "$0")/.."
mkdir -p secrets

gpg --symmetric --cipher-algo AES256 --yes -o secrets/env.gpg .env
gpg --symmetric --cipher-algo AES256 --yes -o secrets/duckdns.gpg .secrets/duckdns.env
gpg --symmetric --cipher-algo AES256 --yes -o secrets/github_deploy_key.gpg /home/deploy/.ssh/planka_deploy_key

echo "Wrote secrets/env.gpg, secrets/duckdns.gpg, secrets/github_deploy_key.gpg"
echo "Review with 'git status', then commit."
