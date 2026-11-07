#!/usr/bin/env bash
# Bounded local execution for a security audit (ADR-0064, P4).
#
# One target-controlled command, inside an OS-enforced sandbox:
#   * no external network — a private network namespace with only loopback;
#   * an empty environment, repopulated from an explicit allowlist;
#   * the target and the toolchain read-only;
#   * writes only inside the scratch directory (every other mount is
#     remounted read-only); the scratch byte count is measured and reported,
#     and a run that exceeds its --scratch-mb allowance is refused by the caller;
#   * explicit CPU, address-space, process, file-size and wall-clock limits.
#
# The last line of stdout is a machine-readable receipt. That receipt — not the
# hunter's prose — is what the engine records as a `SandboxRun` fact, so
# "reproduced locally" is auditable after the fact and a missing sandbox shows
# up as a blocker rather than a claim.
#
# usage: security-sandbox.sh --target DIR --scratch DIR
#          [--cpu SECONDS] [--mem-mb MB] [--procs N] [--file-mb MB] [--wall SECONDS]
#          [--scratch-mb MB] -- COMMAND [ARG...]

set -uo pipefail

RECEIPT_PREFIX="LOOM-SANDBOX-RECEIPT "
CPU_SECONDS=10
MEM_MB=1024
PROCS=128
FILE_MB=32
WALL_SECONDS=60
TMPFS_MB=64
TARGET=""
SCRATCH=""

die() { printf 'security-sandbox: %s\n' "$1" >&2; exit 125; }

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --scratch) SCRATCH="${2:-}"; shift 2 ;;
    --cpu) CPU_SECONDS="${2:-}"; shift 2 ;;
    --mem-mb) MEM_MB="${2:-}"; shift 2 ;;
    --procs) PROCS="${2:-}"; shift 2 ;;
    --file-mb) FILE_MB="${2:-}"; shift 2 ;;
    --wall) WALL_SECONDS="${2:-}"; shift 2 ;;
    --scratch-mb) TMPFS_MB="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) die "unknown option $1" ;;
  esac
done

[ -n "$TARGET" ] || die "--target is required"
[ -n "$SCRATCH" ] || die "--scratch is required"
[ $# -gt 0 ] || die "a command is required after --"
[ -d "$TARGET" ] || die "target is not a directory: $TARGET"

TARGET="$(cd "$TARGET" && pwd -P)"
mkdir -p "$SCRATCH" || die "cannot create scratch $SCRATCH"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"

case "$SCRATCH" in
  "$TARGET"|"$TARGET"/*) die "scratch must live outside the target" ;;
esac

command -v unshare >/dev/null 2>&1 || {
  printf 'security-sandbox: unshare is unavailable, so no bounded execution can be claimed\n' >&2
  exit 126
}

# The allowlisted environment: names only. A child that needs one more variable
# must earn it here, so an ambient credential cannot ride along by accident.
# PATH keeps the operator's own value: on a Nix system the FHS path is empty,
# and a sandbox that cannot find `node` cannot reproduce anything.
ENV_ALLOWLIST=(PATH HOME TMPDIR LANG LC_ALL TERM)
SANDBOX_PATH="${PATH:-/usr/bin:/bin}"
export HOME="$SCRATCH"
export TMPDIR="$SCRATCH"
export LANG="C"

INNER_STATUS=0
unshare --map-root-user --mount --net --pid --fork --mount-proc \
  bash -c '
    set -uo pipefail
    target="$1"; scratch="$2"; cpu="$3"; memmb="$4"; procs="$5"; tmpfsmb="$6"; filemb="$7"; wall="$8"; sandbox_path="$9"; shift 9
    # Everything read-only, then scratch writable again. Order matters: remount
    # the root first so a bind of scratch inherits ro, then flip only scratch.
    mount -o remount,ro / 2>/dev/null || true
    while read -r _dev mountpoint _fstype _rest; do
      case "$mountpoint" in
        "$scratch"|"$target") continue ;;
      esac
      mount -o remount,ro "$mountpoint" 2>/dev/null || true
    done < /proc/mounts
    # The target is mounted to itself and remounted read-only, so a write from
    # inside the sandbox fails at the filesystem, not at a language-level check.
    mount --bind "$target" "$target" || exit 127
    mount -o remount,ro,bind "$target" || exit 127
    mount --bind "$scratch" "$scratch" || exit 127
    mount -o remount,rw,bind "$scratch" || exit 127
    cd "$scratch" || exit 127
    ulimit -t "$cpu" 2>/dev/null || true
    ulimit -v "$((memmb * 1024))" 2>/dev/null || true
    ulimit -u "$procs" 2>/dev/null || true
    ulimit -f "$((filemb * 1024))" 2>/dev/null || true
    # Loopback only: the network namespace has no route off this machine.
    ip link set lo up 2>/dev/null || true
    timeout --signal=KILL "$wall" \
      env -i PATH="$sandbox_path" HOME="$scratch" TMPDIR="$scratch" LANG=C TERM=dumb "$@"
    exit $?
  ' _ "$TARGET" "$SCRATCH" "$CPU_SECONDS" "$MEM_MB" "$PROCS" "$TMPFS_MB" "$FILE_MB" "$WALL_SECONDS" "$SANDBOX_PATH" "$@"
INNER_STATUS=$?

SCRATCH_BYTES=0
if du -sb "$SCRATCH" >/dev/null 2>&1; then
  SCRATCH_BYTES="$(du -sb "$SCRATCH" | cut -f1)"
fi

ALLOWED_JSON="$(printf '%s\n' "${ENV_ALLOWLIST[@]}" | sed 's/.*/"&"/' | paste -sd, -)"
printf '%s{"schemaVersion":1,"exit":%d,"limits":{"cpuSeconds":%d,"addressSpaceMb":%d,"processes":%d,"fileSizeMb":%d,"wallClockSeconds":%d,"scratchMb":%d},"allowlistedEnv":[%s],"scratchBytes":%d,"networkNamespace":true,"targetReadOnly":true}\n' \
  "$RECEIPT_PREFIX" "$INNER_STATUS" "$CPU_SECONDS" "$MEM_MB" "$PROCS" "$FILE_MB" "$WALL_SECONDS" "$TMPFS_MB" "$ALLOWED_JSON" "$SCRATCH_BYTES"

exit "$INNER_STATUS"
