# Idempotency Reference (Security Side)

The general rule is in `rules/architecture.md` → "Effects are retry-safe": assume every command arrives more than once, and make the effect happen once. This file covers what goes wrong for security when that is done loosely, using a card charge as the example.

## The Attacks

| Weakness | Consequence |
|----------|-------------|
| No deduplication, or deduplication after the effect | Retry, double-click or replayed request charges twice |
| Check-then-insert | Two concurrent requests both see "new" and both charge |
| Key is global, not per principal | Tenant B replays or blocks tenant A's payment by guessing or reusing a key |
| Key not bound to the command | Same key, different amount or payment method: a changed command rides on an approved one |
| Replay answered to anyone holding the key | The stored response (receipt, masked card, order) leaks to another principal |
| Timeout treated as failure | Key released, client retries, second charge |
| Unbounded client-chosen key | Storage growth and index bloat on demand |
| Webhook processed before its signature is checked, or twice | Forged or repeated "payment succeeded" |

## Requirements

1. **Scope the key to the authenticated principal.** The principal comes from the session or token, never from the request body. Uniqueness is on `(principal_id, idempotency_key)`.
2. **Claim before the effect, atomically.** A unique constraint and one `INSERT`, committed before the downstream call. Never `SELECT` then `INSERT`.
3. **Store a fingerprint of the command** (hash of amount, currency, payment method, recipient). Same key with a different fingerprint is an error, not a replay.
4. **Replay only to the owner.** The lookup is by principal and key, so another principal's key is simply not found.
5. **Unknown outcome stays pending.** A timeout or crash is not a failure: keep the attempt, reconcile with the downstream system, never release the key and never retry blind.
6. **Pass the same key downstream** so the payment provider deduplicates the same attempt. If the provider has no idempotency support, query it for the charge before retrying.
7. **Bound the key.** Parse it at the boundary: fixed charset, 16 to 64 characters (a UUID fits). Expire attempts on a documented TTL longer than the client's retry window.
8. **Never the card number.** The service holds a payment-provider token. The key, the token and the fingerprint input stay out of logs; amounts are integer minor units plus currency.
9. **Webhooks:** verify the signature over the raw body first (HMAC, constant-time compare, timestamp tolerance), then deduplicate on the provider's event id with a unique constraint, in the same transaction as the state change.

## Sketch (Spring, PostgreSQL)

```sql
CREATE TABLE charge_attempt (
    principal_id    UUID         NOT NULL,
    idempotency_key VARCHAR(64)  NOT NULL,
    fingerprint     CHAR(64)     NOT NULL,       -- SHA-256 hex of the canonical command
    outcome         JSONB,                       -- NULL while pending
    expires_at      TIMESTAMPTZ  NOT NULL,
    UNIQUE (principal_id, idempotency_key)
);
```

```java
// Pure core: no I/O, no clock. A stored attempt is pending or settled, never both.
public sealed interface Attempt {
    String fingerprint();
    record Pending(String fingerprint) implements Attempt {}
    record Settled(String fingerprint, Outcome outcome) implements Attempt {}
}

public sealed interface Decision {
    record Charge() implements Decision {}                    // first sight of this key
    record Replay(Outcome outcome) implements Decision {}     // settled: return the stored answer
    record Reconcile() implements Decision {}                 // an earlier run stopped mid-flight
    record KeyReused() implements Decision {}                 // same key, different command
}

public static Decision decide(Optional<Attempt> existing, String fingerprint) {
    if (existing.isEmpty()) return new Decision.Charge();
    Attempt attempt = existing.get();
    if (!attempt.fingerprint().equals(fingerprint)) return new Decision.KeyReused();
    return switch (attempt) {
        case Attempt.Pending pending -> new Decision.Reconcile();
        case Attempt.Settled settled -> new Decision.Replay(settled.outcome());
    };
}
```

The shell has no policy of its own. In order:

1. **Claim**: `INSERT ... ON CONFLICT (principal_id, idempotency_key) DO NOTHING`, committed in its own transaction. If the insert created the row, `existing` is empty; otherwise it is the row that was already there.
2. **Decide**: `decide(existing, fingerprint)`.
3. **Act**: `KeyReused` returns an error (422). `Replay` returns the stored outcome. `Charge` and `Reconcile` take the same path: call the provider with the key `principalId:idempotencyKey`, the same on every retry, so it charges at most once.
4. **Settle**: store the outcome. If the provider's answer is unknown, store nothing and answer "in progress" (409 or 202); the attempt stays pending and the next retry reconciles.

`principal_id` comes from the security context; the key is a parsed `IdempotencyKey`, usually from an `Idempotency-Key` request header. A declined charge is a settled outcome and is replayed like a success.

## Tests

`decide` is tested as a pure function. The shell is tested with a counting fake provider (retries, timeouts and crashes on one key produce at most one charge), with N parallel calls on one key, with the same key under two principals (two independent attempts, neither readable by the other), and with webhooks (bad signature changes nothing; a repeated event id changes state once).

## Quick Reference

| Do | Don't |
|----|-------|
| Unique `(principal_id, idempotency_key)`, claimed by `INSERT` before the effect | Global keys; check-then-insert; dedup after the charge |
| Fingerprint the command; reject key reuse with a changed command | Replay whatever is stored for the key |
| Keep unknown outcomes pending and reconcile | Release the key on timeout |
| Same key to the payment provider | A fresh provider key per retry |
| Bounded key format, documented TTL | Arbitrary client strings in a unique index |
| Provider token, nothing sensitive in logs | Card numbers, keys or tokens in logs |
| Verify webhook signature, then dedupe on event id | Process first, verify later |
