#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="/home/deploy/planka/.secrets/duckdns.env"
LOG_FILE="/home/deploy/planka/logs/duckdns-update.log"

if [[ ! -r "$CONFIG_FILE" ]]; then
  printf '%s DuckDNS config file is missing or unreadable\n' "$(date -Is)" >> "$LOG_FILE"
  exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG_FILE"

if [[ -z "${DUCKDNS_DOMAIN:-}" || -z "${DUCKDNS_TOKEN:-}" ]]; then
  printf '%s DuckDNS domain or token is not configured\n' "$(date -Is)" >> "$LOG_FILE"
  exit 1
fi

response="$(
  /usr/bin/curl \
    --silent \
    --show-error \
    --fail \
    --max-time 20 \
    --get \
    --data-urlencode "domains=${DUCKDNS_DOMAIN}" \
    --data-urlencode "token=${DUCKDNS_TOKEN}" \
    --data-urlencode "ip=" \
    "https://www.duckdns.org/update"
)"

if [[ "$response" == "OK" ]]; then
  printf '%s DuckDNS update succeeded for %s\n' "$(date -Is)" "$DUCKDNS_DOMAIN" >> "$LOG_FILE"
else
  printf '%s DuckDNS update returned %s for %s\n' "$(date -Is)" "$response" "$DUCKDNS_DOMAIN" >> "$LOG_FILE"
  exit 1
fi
