# Attribution — vendored security lenses

`references/security-lenses/*.md` (except this file, `LOOM-DELTAS.md` and `MANIFEST.json`)
are copied byte-identically from Cloudflare's security-audit skill.

| | |
|---|---|
| Upstream | <https://github.com/cloudflare/security-audit-skill> |
| Commit | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` |
| Path | `skills/security-audit/` |
| License | MIT — see upstream `LICENSE` |
| Retrieved | 2026-11-07 |
| Design rationale | <https://blog.cloudflare.com/build-your-own-vulnerability-harness/> |

Vendored files, with the SHA-256 each must retain: `MANIFEST.json`. The
`security-lens-manifest` test fails when a vendored file changes without the
manifest, so drift is a decision rather than an accident.

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
