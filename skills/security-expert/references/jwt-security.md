# JWT Security Reference

## JWT Structure

```
header.payload.signature
```

```json
{ "alg": "RS256", "typ": "at+jwt", "kid": "key-identifier" }
```

```json
{
  "iss": "https://auth.example.com",
  "sub": "user-123",
  "aud": ["api.example.com"],
  "exp": 1700000000,
  "iat": 1699999000,
  "nbf": 1699999000,
  "jti": "unique-token-id",
  "scope": "read write",
  "roles": ["user", "admin"]
}
```

### Required Claim Validations
| Claim | Validation | Risk if Missing |
|-------|------------|-----------------|
| `exp` | Token not expired | Token replay indefinitely |
| `iss` | Matches expected issuer | Accept tokens from attackers |
| `aud` | Contains your service | Cross-service token abuse |
| `nbf` | Current time >= nbf | Premature token use |

Also check what kind of token it is. An ID token is for the client that logged the user in; it is not an access token and an API must not accept it. Require an access token for your audience, and where the issuer sets the header, require `typ: at+jwt` (RFC 9068).

## Common Vulnerabilities

| Attack | How | Prevention |
|--------|-----|------------|
| Algorithm confusion | `alg` changed from RS256 to HS256; token signed with the public key as HMAC secret | Configure the accepted algorithms; the token header never chooses |
| `alg: none` | Signature removed | Same allowlist; never a "decode without verifying" call on a path that authorizes |
| Key injection | Token carries its own key (`jwk`, `x5c`) or points to one (`jku`, `x5u`); or `kid` is used unsanitised in a file path or SQL lookup | Take keys only from the JWKS URI fixed in configuration; treat `kid` as a lookup key into that set |
| Weak HMAC secret | Offline brute force of HS256 | Asymmetric keys (RS256, ES256); for HMAC, 256 random bits |
| Cross-service reuse | A token issued for service A replayed to service B | Validate `aud` |
| Token type confusion | ID token or refresh token sent as access token | Check `typ` / token use, audience |
| Token theft | XSS, logs, a leaked bearer token | Short lifetime; sender-constrained tokens (DPoP, RFC 9449, or mTLS, RFC 8705); keep tokens out of logs and URLs |

Do not pin key IDs: the issuer rotates keys by publishing a new `kid` in the JWKS, and a pinned list breaks on rotation.

## Validation (Spring Security)

Validation belongs in the decoder, so no request reaches a controller with an unvalidated token. Do not re-check claims by hand afterwards.

```java
@Bean
JwtDecoder jwtDecoder() {
    NimbusJwtDecoder decoder = NimbusJwtDecoder
        .withJwkSetUri("https://auth.example.com/realms/app/protocol/openid-connect/certs")   // fixed in config
        .jwsAlgorithm(SignatureAlgorithm.RS256)                // accepted algorithms
        .build();

    decoder.setJwtValidator(JwtValidators.createDefaultWithValidators(   // defaults: exp and nbf, 60 s clock skew
        new JwtIssuerValidator("https://auth.example.com/realms/app"),
        new JwtClaimValidator<List<String>>(JwtClaimNames.AUD,
            aud -> aud != null && aud.contains("my-api"))));
    return decoder;
}
```

- `createDefaultWithValidators` exists from Spring Security 6.3. Earlier: `new DelegatingOAuth2TokenValidator<>(JwtValidators.createDefaultWithIssuer(issuer), audienceValidator)`. `createDefaultWithIssuer` already validates timestamps; adding a second `JwtTimestampValidator` is redundant.
- With Spring Boot the same result needs no bean: set `spring.security.oauth2.resourceserver.jwt.issuer-uri`, `audiences` and, if not RS256, `jws-algorithms`.
- To require RFC 9068 access tokens (Spring Security 6.5+): build the decoder with `.validateTypes(false)` and set `JwtValidators.createAtJwtValidator().issuer(...).audience(...).clientId(...).build()`.
- Revocation before expiry needs server state: a denylist of `jti` values checked in a validator, or opaque tokens with introspection.

## Token Storage in Browsers

| Storage | Exposed to XSS | Sent automatically (CSRF) | Verdict |
|---------|----------------|---------------------------|---------|
| `localStorage` / `sessionStorage` | Yes, readable by any script | No | Avoid |
| JS memory | Yes, while the page lives | No | Acceptable for short-lived tokens; lost on reload |
| `HttpOnly` cookie | Not readable (still usable by injected script) | Yes | Only together with CSRF protection |
| Server-side session (BFF) | No token in the browser | Session cookie: yes | Preferred for SPAs |

**Backend for frontend (BFF).** The backend is a confidential OAuth client, keeps access and refresh tokens server-side, and gives the browser only a session cookie. See `oauth-oidc.md`.

**A token in a cookie is a cookie credential.** The browser attaches it to cross-site requests, so the API needs CSRF protection. `csrf.disable()` is correct only when no credential is ever sent by cookie (see `csrf-prevention.md` and `spring-security.md`).

```java
ResponseCookie cookie = ResponseCookie.from("__Host-access", token)
    .httpOnly(true)
    .secure(true)
    .sameSite("Strict")
    .path("/")                           // required by the __Host- prefix; no Domain attribute
    .maxAge(Duration.ofMinutes(15))
    .build();
```

## Refresh Tokens

### Rotation with family revocation
1. Access token: short-lived (about 15 minutes), stateless.
2. Refresh token: opaque random value, stored server-side as a hash, belongs to a family created at login.
3. Each refresh consumes the presented token and issues a new pair in the same family.
4. A consumed token presented again means the token leaked: revoke the whole family.

Consuming the token must be one atomic statement. Read-then-write lets two concurrent requests both see "unused" and both receive a new pair.

```java
public sealed interface RefreshResult {
    record Rotated(TokenPair tokens) implements RefreshResult {}
    record Rejected(String reason) implements RefreshResult {}
}

@Transactional
public RefreshResult refresh(String presentedToken) {
    String hash = sha256Hex(presentedToken);                   // the plaintext token is never stored
    Optional<RefreshToken> found = refreshTokens.findByTokenHash(hash);
    if (found.isEmpty()) return new RefreshResult.Rejected("unknown");
    RefreshToken row = found.get();

    // UPDATE refresh_token SET used_at = :now WHERE token_hash = :hash AND used_at IS NULL
    boolean claimed = refreshTokens.markUsed(hash, clock.instant()) == 1;
    if (!claimed) {
        refreshTokens.revokeFamily(row.familyId());            // reuse detected
        return new RefreshResult.Rejected("reuse");
    }
    if (row.revoked() || row.expiresAt().isBefore(clock.instant())) {
        return new RefreshResult.Rejected("expired");
    }
    return new RefreshResult.Rotated(issuePair(row.userId(), row.familyId()));
}
```

The result is a value, not an exception: throwing from the reuse branch would roll back the family revocation. The row count of the `UPDATE` is the only test of "unused"; exactly one concurrent caller gets `1`. A client that retries a refresh after a lost response trips reuse detection and has to log in again, which is the intended trade-off. `idempotency.md` covers the general pattern.

### Sender-constrained tokens
Rotation detects theft after the fact. Binding prevents use of a stolen token: DPoP (RFC 9449) ties the token to a key held by the client, and mutual-TLS-bound tokens (RFC 8705) tie it to the client certificate. RFC 9700 requires refresh tokens of public clients to be sender-constrained or rotated.

## Quick Reference

| Do | Don't |
|----|-------|
| Validate signature, `iss`, `aud`, `exp`, `nbf` in the decoder | Decode and trust claims |
| Fix the algorithm list and the JWKS URI in configuration | Follow `alg`, `jku`, `jwk`, `x5u` from the token |
| Accept only access tokens for your audience | Accept ID tokens at an API |
| Short access tokens, rotated or bound refresh tokens | Long-lived bearer tokens |
| BFF or CSRF-protected cookie for browsers | Tokens in `localStorage`; cookie tokens with CSRF off |
| Atomic single-use refresh, stored hashed | Check-then-set, plaintext lookup |
