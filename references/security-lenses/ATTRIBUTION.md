# Attribution — vendored security lenses

`references/security-lenses/*.md` (except this file, `LOOM-DELTAS.md` and `MANIFEST.json`)
are copied byte-identically from Cloudflare's security-audit skill.

`MANIFEST.json` is the machine source of truth: it pins the SHA-256 of each of
the eleven vendored files and records the upstream repository, commit, source
directory, license and retrieval date. The table below is a human-readable
summary of it; where the two disagree, the manifest wins.

| | |
|---|---|
| Upstream | <https://github.com/cloudflare/security-audit-skill> |
| Commit, path, retrieved | see `MANIFEST.json` → `upstream` |
| License | MIT — see upstream `LICENSE` |
| Design rationale | <https://blog.cloudflare.com/build-your-own-vulnerability-harness/> |

The `security-lens-manifest` test re-digests every vendored file against
`MANIFEST.json` and fails when one changes without the manifest, so drift is a
decision rather than an accident. Loom-specific guidance about these lenses
lives in `LOOM-DELTAS.md`, never inside a vendored file.

Why these eleven and nothing else: they are the reconnaissance and attack-class
taxonomy — the part of upstream that is pure domain knowledge and therefore both
the most valuable and the least Loom-specific. Upstream's phase prose
(`SKILL.md`, `RECONNAISSANCE.md`, `HUNTING.md`, `VALIDATION-AND-REPORTING.md`),
its JSON schema and its `.cjs` validators are **not** vendored as reference:
Loom's program owns orchestration, its pure cores own validation, and upstream's
validators live on only as a differential-test oracle under
`engine/tests/fixtures/security/upstream/`.

Upstream filenames are preserved verbatim (uppercase) on purpose: those files
cross-reference each other by exact name, so renaming them would either break
links or require editing vendored bytes. A copy that stays copyable is worth
more than a naming convention.

MIT obligations: retain the copyright and permission notice. Upstream's notice
is reproduced at `engine/tests/fixtures/security/upstream/LICENSE` alongside the
oracle validators; this file records the attribution for the vendored taxonomy.
