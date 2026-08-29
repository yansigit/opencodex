#!/usr/bin/env bash
set -uo pipefail

if [[ "${1:-}" != "--" || "$#" -lt 2 ]]; then
  echo "usage: $0 -- <command> [args...]" >&2
  exit 64
fi
shift

log_file="$(mktemp -t ocx-bun-crash.XXXXXX)"
cleanup() { rm -f -- "$log_file"; }
trap cleanup EXIT

for attempt in 1 2; do
  set +e
  "$@" 2>&1 | tee "$log_file"
  status="${PIPESTATUS[0]}"
  set -e
  if [[ "$status" -eq 0 ]]; then exit 0; fi
  if ! grep -Eqi 'oh no: Bun has crashed|Internal assertion failure|Segmentation fault at address|Illegal instruction|Bus error|Aborted \(core dumped\)' "$log_file"; then
    echo "::error::command failed on attempt ${attempt} (exit ${status}); assertion failures are not retried."
    exit "$status"
  fi
  echo "::warning::Bun runtime crash on attempt ${attempt}; retrying once."
done

echo "::error::Bun runtime crash repeated; failing after one retry."
exit 1
