#!/usr/bin/env bash
set -euo pipefail

readonly SHARD_SPEC="${1:-}"
readonly BATCH_SIZE="${BUN_TEST_BATCH_SIZE:-12}"
readonly BATCH_TIMEOUT_SECONDS="${BUN_TEST_BATCH_TIMEOUT_SECONDS:-120}"
readonly BATCH_KILL_GRACE_SECONDS="${BUN_TEST_BATCH_KILL_GRACE_SECONDS:-15}"
# Runtime under test. Defaults to whatever `bun` PATH resolves to; the Bun 1.4
# qualification lane sets OPENCODEX_BUN_PATH so the batches actually execute on
# the candidate binary. Without this the lane would export an override, run the
# bundled stable runtime anyway, and report a qualification it never performed.
readonly BUN_BIN="${OPENCODEX_BUN_PATH:-bun}"
readonly TIMING_FILE="${BUN_TEST_TIMINGS_FILE:-.bun-timings.json}"

usage() {
  echo "usage: $0 <shard/total>" >&2
  exit 64
}

if [[ ! "$SHARD_SPEC" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]]; then
  usage
fi

readonly SHARD_INDEX="${BASH_REMATCH[1]}"
readonly SHARD_COUNT="${BASH_REMATCH[2]}"

if (( SHARD_INDEX > SHARD_COUNT )); then
  usage
fi
if [[ ! "$BATCH_SIZE" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_TEST_BATCH_SIZE must be a positive integer, got: $BATCH_SIZE" >&2
  exit 64
fi
if [[ ! "$BATCH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_TEST_BATCH_TIMEOUT_SECONDS must be a positive integer, got: $BATCH_TIMEOUT_SECONDS" >&2
  exit 64
fi
if [[ ! "$BATCH_KILL_GRACE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_TEST_BATCH_KILL_GRACE_SECONDS must be a positive integer, got: $BATCH_KILL_GRACE_SECONDS" >&2
  exit 64
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "GNU timeout is required to bound Bun test batches." >&2
  exit 69
fi

is_bun_runtime_crash() {
  local status="$1"
  local log_file="$2"

  case "$status" in
    132|133|134|135|136|137|139)
      return 0
      ;;
  esac

  # Bun 1.3.14 can surface a Linux epoll registration failure as exit 1,
  # even though the failure comes from Bun's internal WriteStream setup rather
  # than a test assertion. Treat only that narrow runtime signature as a crash.
  if (( status == 1 )) \
    && grep -Fq '# Unhandled error between tests' "$log_file" \
    && grep -Fq 'error: EEXIST: file already exists, epoll_ctl' "$log_file" \
    && grep -Fq 'at new WriteStream (internal:fs/streams:' "$log_file"; then
    return 0
  fi

  grep -Eqi \
    'oh no: Bun has crashed|Internal assertion failure|Segmentation fault at address|Illegal instruction|Bus error|Aborted \(core dumped\)' \
    "$log_file"
}

LAST_FAILURE_KIND=""

run_test_once() {
  local batch_number="$1"
  local phase="$2"
  local attempt="$3"
  shift 3
  local -a files=("$@")
  local log_file
  local status
  local label="shard ${SHARD_SPEC} batch ${batch_number}/${TOTAL_BATCHES}"

  if [[ -n "$phase" ]]; then
    label+=" ${phase}"
  fi

  log_file="$(mktemp -t ocx-bun-test-batch.XXXXXX)"

  echo "::group::${label} attempt ${attempt} (${#files[@]} files)"
  printf '  %s\n' "${files[@]}"

  set +e
  timeout --signal=TERM --kill-after="${BATCH_KILL_GRACE_SECONDS}s" \
    "${BATCH_TIMEOUT_SECONDS}s" \
    "$BUN_BIN" test --isolate --timeout 60000 --timings "$TIMING_FILE" --update-timings "${files[@]}" 2>&1 | tee "$log_file"
  status="${PIPESTATUS[0]}"
  set -e

  echo "::endgroup::"

  if (( status == 0 )); then
    LAST_FAILURE_KIND=""
    rm -f -- "$log_file"
    return 0
  fi

  if (( status == 124 )); then
    LAST_FAILURE_KIND="timeout"
    echo "::warning::Bun test process timed out after ${BATCH_TIMEOUT_SECONDS}s in ${label} (attempt ${attempt})."
    rm -f -- "$log_file"
    return "$status"
  fi

  if is_bun_runtime_crash "$status" "$log_file"; then
    LAST_FAILURE_KIND="runtime"
    echo "::warning::Bun runtime crash in ${label} (exit ${status}, attempt ${attempt})."
    rm -f -- "$log_file"
    return "$status"
  fi

  LAST_FAILURE_KIND="test"
  echo "::error::Test failure in ${label} (exit ${status}); not retrying assertion/test failures."
  rm -f -- "$log_file"
  return "$status"
}

recover_batch_file_by_file() {
  local batch_number="$1"
  local batch_failure_kind="$2"
  shift 2
  local -a files=("$@")
  local file
  local file_index=0
  local status
  local retry_kind

  echo "::warning::Shard ${SHARD_SPEC} batch ${batch_number} hit a ${batch_failure_kind}; rerunning its ${#files[@]} files one at a time in fresh Bun processes."

  for file in "${files[@]}"; do
    ((file_index += 1))
    if run_test_once "$batch_number" "singleton ${file_index}/${#files[@]}" 1 "$file"; then
      continue
    else
      status=$?
    fi

    if [[ "$LAST_FAILURE_KIND" != "runtime" && "$LAST_FAILURE_KIND" != "timeout" ]]; then
      echo "::error::Singleton isolation identified ${file} as a failing test file."
      return "$status"
    fi

    retry_kind="$LAST_FAILURE_KIND"
    echo "Retrying ${file} once in another fresh Bun process after ${retry_kind} failure..."
    if run_test_once "$batch_number" "singleton ${file_index}/${#files[@]}" 2 "$file"; then
      echo "::warning::${file} passed on its single ${retry_kind} retry."
      continue
    else
      status=$?
    fi

    if [[ "$LAST_FAILURE_KIND" == "timeout" ]]; then
      echo "::error::${file} timed out twice under singleton isolation; failing after one retry."
    elif [[ "$LAST_FAILURE_KIND" == "runtime" ]]; then
      echo "::error::Bun runtime crash repeated for ${file} under singleton isolation; failing after one retry."
    else
      echo "::error::${file} failed during singleton retry."
    fi
    return "$status"
  done

  echo "::warning::Shard ${SHARD_SPEC} batch ${batch_number} passed under singleton isolation after the original ${batch_failure_kind}; continuing."
  return 0
}

mapfile -t ORDERED_GENERAL_FILES < <(
  "$BUN_BIN" scripts/ci/test-lanes.ts --lane general --timings "$TIMING_FILE" --shard "$SHARD_SPEC"
)

SELECTED_FILES=()
SELECTED_FILES=("${ORDERED_GENERAL_FILES[@]}")

if (( ${#SELECTED_FILES[@]} == 0 )); then
  echo "No tests selected for shard ${SHARD_SPEC}." >&2
  exit 1
fi

readonly TOTAL_BATCHES=$(( (${#SELECTED_FILES[@]} + BATCH_SIZE - 1) / BATCH_SIZE ))
echo "Shard ${SHARD_SPEC}: ${#SELECTED_FILES[@]} files in ${TOTAL_BATCHES} primary Bun processes (timing-aware longest-first allocation, batch size <= ${BATCH_SIZE}, timeout ${BATCH_TIMEOUT_SECONDS}s)."
echo "Runtime crashes and timeouts fall back to one-file-per-process isolation; assertion/test failures do not retry."

for ((batch_index = 0; batch_index < TOTAL_BATCHES; batch_index += 1)); do
  start=$(( batch_index * BATCH_SIZE ))
  batch=("${SELECTED_FILES[@]:start:BATCH_SIZE}")
  batch_number=$(( batch_index + 1 ))

  if run_test_once "$batch_number" "" 1 "${batch[@]}"; then
    continue
  else
    status=$?
  fi

  if [[ "$LAST_FAILURE_KIND" != "runtime" && "$LAST_FAILURE_KIND" != "timeout" ]]; then
    exit "$status"
  fi

  failure_kind="$LAST_FAILURE_KIND"
  if recover_batch_file_by_file "$batch_number" "$failure_kind" "${batch[@]}"; then
    continue
  else
    exit $?
  fi
done

# Bun updates the timing file in place, including restored entries from the
# canonical cache. Publish only this shard's entries so the trusted-dev merge
# job receives four disjoint reports rather than four copies of the baseline.
"$BUN_BIN" scripts/ci/select-timings.ts "$TIMING_FILE" "${SELECTED_FILES[@]}"
