#!/usr/bin/env bash
# Bounded local execution for a security audit (ADR-0066, P4).
#
# One target-controlled command, inside an OS-enforced sandbox:
#   * no external network — a private network namespace with only loopback;
#   * an empty environment, repopulated from an explicit allowlist;
#   * the target and the operator's home read-only (each OBSERVED: a write to
#     it must have failed), every other mountpoint
#     remounted read-only where the namespace allows it, and the scratch
#     directory writable — measured and reported after the run;
#   * explicit CPU, address-space, process, file-size and wall-clock limits.
#
# The last line of stdout is a machine-readable receipt. That receipt — not the
# hunter's prose — is what the engine records as a `SandboxRun` fact, so
# "reproduced locally" is auditable after the fact and a missing sandbox shows
# up as a blocker rather than a claim.
#
# Three properties make the receipt evidence rather than a string:
#   * the command's own stdout is captured and printed BEFORE the receipt, so a
#     command that prints a receipt line cannot outrank the script's own;
#   * with `--nonce`, the receipt prefix carries a value the caller generated,
#     so a command that prints a receipt line cannot match it;
#   * the enforcement facts travel on the INNER shell's stdout, which the command
#     cannot write to: its own stdout goes to a file, and the inner shell points
#     its OWN stdout and stderr at /dev/null right after printing the facts line,
#     before the command starts. That shell is PID 1 of the pid namespace, so
#     while it held the capture pipe the command could reopen it as
#     `/proc/1/fd/1` and append a forged facts line; now no process inside the
#     sandbox holds the pipe, and the outer capture takes the FIRST facts line —
#     the one printed before the command existed. The facts used to round-trip
#     through `$scratch/.enforcement` — a file inside the one directory the
#     command can write — so a refused ulimit could be reported as applied.
# The nonce BINDS a receipt to the artifact path it was produced for; it does
# not authenticate it. A hunter that writes the artifact itself could still
# forge one — the receipt defeats an accidental or command-printed receipt, not
# a dishonest hunter.
#
# The receipt records what the kernel ACTUALLY enforced (`enforced`), whether the
# target, home and root remounts took (`targetReadOnly`, `homeReadOnly`,
# `readOnlyRoot`), and how many OTHER mountpoints could not be closed
# (`unremountedMounts`). `targetReadOnly` is a fact like the rest — the inner
# shell reports it only after a write to the target actually failed, and a
# missing facts line reads it as `false` — not a literal. A limit that could not be applied is reported as
# unenforced, never as applied. Home is bind-remounted read-only because it is
# the one writable surface a user namespace can still close: the uid mapping
# makes the caller the owner inside, so a command that ignored its scratch could
# otherwise edit the operator's own files. `homeReadOnly` is OBSERVED — a write
# to home must have failed — so a remount that silently missed reads as open.
#
# usage: security-sandbox.sh --target DIR --scratch DIR
#          [--cpu SECONDS] [--mem-mb MB] [--procs N] [--file-mb MB] [--wall SECONDS]
#          [--scratch-mb MB] [--nonce HEX] -- COMMAND [ARG...]
#
# `--scratch-mb` is the footprint the engine accepts AFTER the run (it compares
# `scratchBytes` against it); nothing caps the scratch while the command runs.

set -uo pipefail

NONCE=""
RECEIPT_BASE="LOOM-SANDBOX-RECEIPT "
CPU_SECONDS=10
MEM_MB=1024
PROCS=128
FILE_MB=32
WALL_SECONDS=60
SCRATCH_MB=64
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
    --scratch-mb) SCRATCH_MB="${2:-}"; shift 2 ;;
    --nonce) NONCE="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) die "unknown option $1" ;;
  esac
done

if [ -n "$NONCE" ]; then
  case "$NONCE" in
    *[!0-9a-f]*) die "--nonce must be lowercase hex" ;;
  esac
  [ "${#NONCE}" -ge 16 ] || die "--nonce must be at least 16 hex characters"
  RECEIPT_PREFIX="LOOM-SANDBOX-RECEIPT-${NONCE} "
else
  RECEIPT_PREFIX="$RECEIPT_BASE"
fi

[ -n "$TARGET" ] || die "--target is required"
[ -n "$SCRATCH" ] || die "--scratch is required"
[ $# -gt 0 ] || die "a command is required after --"
[ -d "$TARGET" ] || die "target is not a directory: $TARGET"

# Checked before anything is created: a sandbox that cannot start must leave no
# half-prepared run directory, and the refusal names the missing capability so a
# hunter records a blocker instead of running the command anyway.
command -v unshare >/dev/null 2>&1 || {
  printf 'security-sandbox: unshare is unavailable, so no bounded execution can be claimed\n' >&2
  exit 126
}

TARGET="$(cd "$TARGET" && pwd -P)"
mkdir -p "$SCRATCH" || die "cannot create scratch $SCRATCH"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"

case "$SCRATCH" in
  "$TARGET"|"$TARGET"/*) die "scratch must live outside the target" ;;
esac

# The directory the sandbox has to close. It is not necessarily the scratch,
# and the child's own HOME is pointed at the scratch below.
REAL_HOME="${HOME:-}"
if [ -n "$REAL_HOME" ]; then
  REAL_HOME="$(cd "$REAL_HOME" 2>/dev/null && pwd -P)" || REAL_HOME=""
fi

# The allowlisted environment, as the exact assignments the child receives. The
# receipt's `allowlistedEnv` is derived from THIS array, so the names a receipt
# reports and the names `env -i` passes cannot disagree; the engine compares
# them against SANDBOX_ENV_ALLOWLIST. A child that needs one more variable must
# earn it here, so an ambient credential cannot ride along by accident. PATH
# keeps the operator's own value: on a Nix system the FHS path is empty, and a
# sandbox that cannot find `node` cannot reproduce anything.
ENV_ASSIGNMENTS=("PATH=${PATH:-/usr/bin:/bin}" "HOME=$SCRATCH" "TMPDIR=$SCRATCH" "LANG=C" "TERM=dumb")

COMMAND_STDOUT="$SCRATCH/.command-stdout"
rm -f "$COMMAND_STDOUT"

# The inner shell's OWN stdout is captured here, and the command's stdout is
# redirected to a file inside the sandbox: the two streams never meet, so the
# command cannot forge the enforcement facts the way it could forge a file.
INNER_REPORT="$(unshare --map-root-user --mount --net --pid --fork --mount-proc \
  bash -c '
    set -uo pipefail
    target="$1"; scratch="$2"; cpu="$3"; memmb="$4"; procs="$5"; filemb="$6"; wall="$7"; home="$8"; envcount="$9"
    shift 9
    env_assignments=("${@:1:$envcount}")
    shift "$envcount"
    # Everything read-only that the namespace lets us close. A remount that
    # FAILS is counted, never swallowed: `readOnlyRoot` and `unremountedMounts`
    # are the residual exposure the receipt reports. They are RECORDED, not
    # gated — a user namespace cannot remount a superblock it does not own, so
    # gating on them would refuse every run. Home is what `sandboxWithinLimits`
    # gates on, because it is the one writable surface a namespace CAN close.
    root_ro=1
    mount -o remount,ro / 2>/dev/null || root_ro=0
    unremounted=0
    while read -r _dev mountpoint _fstype _rest; do
      case "$mountpoint" in
        "$scratch"|"$target"|/) continue ;;
      esac
      mount -o remount,ro "$mountpoint" 2>/dev/null || unremounted=$((unremounted + 1))
    done < /proc/mounts
    # Home is closed FIRST: the target and the scratch usually live under it, so
    # their binds must land on top of a read-only home rather than be hidden by a
    # later home bind (which is why home used to be skipped, and reported closed,
    # whenever the target or the scratch sat inside it). `--rbind` keeps the
    # mounts nested in home: a non-recursive bind of a mount with locked children
    # is refused. Home inside the target is closed by the target remount; home
    # that IS the scratch or lies inside it is writable by design, so it reads
    # as open. An unknown home cannot be attested closed, so it reads as open.
    home_ro=0
    if [ -n "$home" ]; then
      home_ro=1
      case "$home" in
        "$scratch"|"$scratch"/*) home_ro=0 ;;
        "$target"|"$target"/*) : ;;
        *)
          if ! { mount --rbind "$home" "$home" 2>/dev/null && mount -o remount,ro,bind "$home" 2>/dev/null; }; then
            home_ro=0
          fi ;;
      esac
    fi
    # The target is mounted to itself and remounted read-only, so a write from
    # inside the sandbox fails at the filesystem, not at a language-level check.
    # A target that cannot be closed ends the run here, before the command and
    # before any facts line — so the receipt reads `targetReadOnly: false`.
    mount --bind "$target" "$target" || exit 127
    mount -o remount,ro,bind "$target" || exit 127
    mount --bind "$scratch" "$scratch" || exit 127
    mount -o remount,rw,bind "$scratch" || exit 127
    # Observed, not inferred: home reads as read-only only after a write to it
    # has actually FAILED, so a remount that silently missed, or a layout the
    # branches above did not foresee, reads as open and never as closed.
    if [ "$home_ro" = 1 ]; then
      probe="$home/.loom-sandbox-home-probe.$$"
      if ( : > "$probe" ) 2>/dev/null; then
        rm -f "$probe"
        home_ro=0
      fi
    fi
    # The target is observed the same way, and it is not merely recorded: a
    # remount that returned zero but left the target writable stops the run
    # before the command starts. Only then is `target_ro` a fact.
    probe="$target/.loom-sandbox-target-probe.$$"
    if ( : > "$probe" ) 2>/dev/null; then
      rm -f "$probe"
      exit 127
    fi
    target_ro=1
    cd "$scratch" || exit 127
    # A limit the kernel refused is recorded as unenforced, never as applied.
    cpu_ok=1; ulimit -t "$cpu" 2>/dev/null || cpu_ok=0
    mem_ok=1; ulimit -v "$((memmb * 1024))" 2>/dev/null || mem_ok=0
    procs_ok=1; ulimit -u "$procs" 2>/dev/null || procs_ok=0
    file_ok=1; ulimit -f "$((filemb * 1024))" 2>/dev/null || file_ok=0
    printf "LOOM-SANDBOX-LIMITS target_ro=%s root_ro=%s home_ro=%s cpu=%s mem=%s procs=%s files=%s unremounted=%s\n" \
      "$target_ro" "$root_ro" "$home_ro" "$cpu_ok" "$mem_ok" "$procs_ok" "$file_ok" "$unremounted"
    # The facts are out: let go of the capture pipe before the command exists.
    # This shell is PID 1 of the pid namespace, so while its stdout stayed the
    # pipe the command could reopen it as /proc/1/fd/1 and append a facts line
    # of its own. stderr (the script stderr) goes too, so no process inside the
    # sandbox holds any stream of the script once the command starts. fd 0, the
    # only other descriptor this shell holds, is the caller stdin.
    exec 1>/dev/null 2>/dev/null
    # Loopback only: the network namespace has no route off this machine.
    ip link set lo up 2>/dev/null || true
    # The command stdout is captured, not streamed: the script must print the
    # receipt LAST, and a command that prints a receipt line must not outrank it.
    timeout --signal=KILL "$wall" env -i "${env_assignments[@]}" "$@" > "$scratch/.command-stdout" 2>&1
    exit $?
  ' _ "$TARGET" "$SCRATCH" "$CPU_SECONDS" "$MEM_MB" "$PROCS" "$FILE_MB" "$WALL_SECONDS" "$REAL_HOME" \
    "${#ENV_ASSIGNMENTS[@]}" "${ENV_ASSIGNMENTS[@]}" "$@")"
INNER_STATUS=$?

[ -f "$COMMAND_STDOUT" ] && cat "$COMMAND_STDOUT"

# The facts line, from the inner shell's stdout only — and the FIRST match. The
# genuine line is printed before the command starts and the inner shell drops
# the pipe right after it, so any later match could only be a forgery that
# reached the pipe some way the redirect did not foresee; taking the last would
# hand it the receipt. Nothing the command does can come first: it has not
# started yet. Every value defaults to "unenforced" when the line is missing, so
# a sandbox that died early can never read as bounded.
LIMITS_LINE="$(printf '%s\n' "$INNER_REPORT" | sed -n 's/^LOOM-SANDBOX-LIMITS target_ro=\([01]\) root_ro=\([01]\) home_ro=\([01]\) cpu=\([01]\) mem=\([01]\) procs=\([01]\) files=\([01]\) unremounted=\([0-9]\{1,\}\)$/\1 \2 \3 \4 \5 \6 \7 \8/p' | head -n1)"
read -r TARGET_RO ROOT_RO HOME_RO CPU_OK MEM_OK PROCS_OK FILE_OK UNREMOUNTED <<< "${LIMITS_LINE:-0 0 0 0 0 0 0 0}"

SCRATCH_BYTES=null
if du -sb "$SCRATCH" >/dev/null 2>&1; then
  SCRATCH_BYTES="$(du -sb "$SCRATCH" | cut -f1)"
fi

bool() { [ "$1" = "1" ] && printf 'true' || printf 'false'; }

ALLOWED_JSON="$(printf '%s\n' "${ENV_ASSIGNMENTS[@]}" | sed 's/=.*//; s/.*/"&"/' | paste -sd, -)"
printf '%s{"schemaVersion":1,"exit":%d,"limits":{"cpuSeconds":%d,"addressSpaceMb":%d,"processes":%d,"fileSizeMb":%d,"wallClockSeconds":%d,"scratchMb":%d},"allowlistedEnv":[%s],"scratchBytes":%s,"networkNamespace":true,"targetReadOnly":%s,"readOnlyRoot":%s,"homeReadOnly":%s,"unremountedMounts":%d,"enforced":{"cpu":%s,"memory":%s,"processes":%s,"fileSize":%s}}\n' \
  "$RECEIPT_PREFIX" "$INNER_STATUS" "$CPU_SECONDS" "$MEM_MB" "$PROCS" "$FILE_MB" "$WALL_SECONDS" "$SCRATCH_MB" "$ALLOWED_JSON" "$SCRATCH_BYTES" \
  "$(bool "$TARGET_RO")" "$(bool "$ROOT_RO")" "$(bool "$HOME_RO")" "${UNREMOUNTED:-0}" "$(bool "$CPU_OK")" "$(bool "$MEM_OK")" "$(bool "$PROCS_OK")" "$(bool "$FILE_OK")"

exit "$INNER_STATUS"
