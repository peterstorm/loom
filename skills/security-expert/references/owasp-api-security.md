# OWASP API Security Top 10 (2023) Checklist

A checklist that points to the reference owning each topic. Samples appear here only where no other reference has them: object-level lookups, login throttling and deprecation headers.

## API1:2023 Broken Object Level Authorization

The caller changes an id and reads or changes someone else's object.

- [ ] Every handler that takes an object id checks that this caller may perform this action on that object.
- [ ] The check uses the authenticated principal, never an owner id from the request.
- [ ] Tests request another user's object and expect 403 or 404.

```java
// Scope the query to the caller: another user's id is simply not found.
Document doc = documents.findByIdAndOwnerId(documentId, auth.getName())
    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
```
Compare ids of the same type: `Long id` against `auth.getName()` (a `String`) with `equals` is always false. Policy-based checks: `authorization-patterns.md`.

## API2:2023 Broken Authentication

- [ ] Tokens validated for signature, issuer, audience and expiry: `jwt-security.md`.
- [ ] Flows per `oauth-oidc.md`; passwords per `password-hashing.md`.
- [ ] Login, password reset and token endpoints are throttled per account and per client address.
- [ ] Responses do not reveal whether the account exists.

One global limiter on the login endpoint lets a single attacker lock everyone out and does nothing against a slow attack on one account. Count failures per account and per address.

```java
public final class LoginThrottle {
    // Caffeine; use a shared store (Redis) when there is more than one node.
    private final Cache<String, AtomicInteger> failures = Caffeine.newBuilder()
        .expireAfterWrite(Duration.ofMinutes(15)).maximumSize(1_000_000).build();

    public boolean isBlocked(String username, String clientAddress) {
        return count("user:" + username) >= 5 || count("addr:" + clientAddress) >= 50;
    }

    public void recordFailure(String username, String clientAddress) {
        failures.get("user:" + username, key -> new AtomicInteger()).incrementAndGet();
        failures.get("addr:" + clientAddress, key -> new AtomicInteger()).incrementAndGet();
    }

    private int count(String key) {
        AtomicInteger n = failures.getIfPresent(key);
        return n == null ? 0 : n.get();
    }
}
```
Check `isBlocked` before verifying the password and answer 429. Pass the username normalised (trimmed, lower-cased, length-capped) and take the client address from your trusted proxy, not from a raw `X-Forwarded-For`. Per-account throttling lets an attacker delay a victim's login: keep the window short, never lock permanently, and add MFA or a challenge rather than raising the limit. With Keycloak, use its brute-force detection (`keycloak.md`).

## API3:2023 Broken Object Property Level Authorization

Mass assignment (the caller sets a field they should not) and excessive data exposure (the response carries fields they should not see).

- [ ] Request bodies bind to a DTO that lists exactly the writable fields; never to an entity.
- [ ] Responses are built from a DTO that lists exactly the readable fields for this caller.

```java
public record UserUpdateRequest(String name, String email) {}                 // no role, no isAdmin
public record UserPublicResponse(String id, String name, String avatarUrl) {} // no password hash, no internal ids
```

## API4:2023 Unrestricted Resource Consumption

- [ ] Rate limits per principal and per address at the gateway or in a filter.
- [ ] Page size capped server-side: `PageRequest.of(page, Math.min(size, 100))`.
- [ ] Request body, upload and extracted-archive limits: `file-upload-security.md`.
- [ ] Timeouts on outbound calls, queries (`@Transactional(timeout = 30)`) and external commands.
- [ ] Limits on anything that costs money per call (SMS, email, third-party APIs).

## API5:2023 Broken Function Level Authorization

- [ ] Routes are denied unless a rule allows them: `.anyRequest().denyAll()` last (`spring-security.md`).
- [ ] Administrative functions are authorized by role at the route and again at the method (`@PreAuthorize`).
- [ ] Authorization does not depend on the client hiding a button or a URL being hard to guess.

## API6:2023 Unrestricted Access to Sensitive Business Flows

Scalping, mass sign-up, referral fraud, scraping: each call is valid; the volume or automation is the abuse.

- [ ] Identify the flows where automation hurts and limit them per account, device and payment instrument.
- [ ] Add friction where needed: challenge, step-up authentication, queueing.
- [ ] Business limits are enforced in the transaction that performs the action, not only in a filter.
- [ ] Money-moving and other one-time effects are retry-safe: `idempotency.md`.

## API7:2023 Server Side Request Forgery

- [ ] Every outbound request whose URL a caller can influence follows `ssrf.md`: host allowlist, HTTPS, no redirects, address filtering in the resolver the client connects with.

## API8:2023 Security Misconfiguration

- [ ] Security headers and CORS: `security-headers.md`.
- [ ] Error responses carry no stack trace, message or binding detail:
  ```yaml
  server:
    error:
      include-message: never
      include-stacktrace: never
      include-binding-errors: never
  ```
- [ ] Actuator exposure is an allowlist (`management.endpoints.web.exposure.include: health,info,prometheus`) and the endpoints require authentication.
- [ ] No default credentials, sample apps or debug endpoints in production; secrets per `secrets-management.md`.
- [ ] XML parsers and deserializers hardened: `xxe-prevention.md`, `deserialization-attacks.md`.

## API9:2023 Improper Inventory Management

- [ ] Every deployed API version and host is listed, owned and documented (OpenAPI).
- [ ] Old versions get the same patches and controls as the current one until they are removed.
- [ ] Deprecated endpoints announce it and have a removal date.

`Deprecation` is a date (RFC 9745), not `true`; `Sunset` (RFC 8594) is an HTTP date no earlier than it.
```java
return ResponseEntity.ok()
    .header("Deprecation", "@1767225599")                       // 2025-12-31T23:59:59Z, seconds since the epoch
    .header("Sunset", "Wed, 30 Jun 2027 23:59:59 GMT")
    .header("Link", "</api/v2/users>; rel=\"successor-version\"")
    .body(users);
```

## API10:2023 Unsafe Consumption of APIs

A third-party response is untrusted input.

- [ ] Parse it into a typed DTO with size and format limits before use; reject what does not parse.
- [ ] Encode or sanitise it for the sink it reaches (`sql-injection.md`, `xss-prevention.md`).
- [ ] URLs it contains go through `ssrf.md` before being fetched.
- [ ] Calls use TLS with certificate validation, timeouts and a response-size limit.
