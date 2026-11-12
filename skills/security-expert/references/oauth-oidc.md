# OAuth 2.0 and OpenID Connect Reference

The rules follow RFC 9700 (OAuth 2.0 Security Best Current Practice). Keycloak settings are in `keycloak.md`; token validation at the API is in `jwt-security.md`.

## Which Flow

| Client | Flow |
|--------|------|
| Server-side web app | Authorization code + PKCE, confidential client |
| Browser SPA | A backend for frontend (BFF) that runs the confidential-client flow; the browser holds a session cookie |
| Mobile or desktop app | Authorization code + PKCE, public client, system browser |
| Service to service | Client credentials |
| Device without a browser | Device authorization grant |

Not used:
- **Implicit grant** (`response_type=token`). RFC 9700: clients should not use it; the access token lands in the URL.
- **Resource owner password credentials.** RFC 9700: must not be used. The client sees the password, and MFA and federation cannot work.

## Authorization Code Flow: Requirements

1. **PKCE with `S256` on every client.** RFC 9700 requires it for public clients and recommends it for confidential ones; this pack uses it everywhere. The verifier is random per request; the challenge is `BASE64URL(SHA256(verifier))`.
2. **Exact redirect URI matching.** Register full URIs; the authorization server compares strings. No wildcards, no open redirector on a registered URI.
3. **`state`**: a random, single-use value bound to the user's browser session and compared on the callback. It stops a forged callback (login CSRF).
4. **`nonce`** (OIDC): random per request, stored with the session, compared with the `nonce` claim of the ID token. It stops ID token replay and injection.
5. **Issuer check**: when the client talks to more than one authorization server, compare the `iss` response parameter (RFC 9207) with the issuer the request was sent to.
6. **The code is exchanged from the back channel**, with client authentication for confidential clients, and can be used once.

Spring Security's OAuth client does this for you: `oauth2Login()` generates and checks `state`, adds and checks `nonce` when `openid` is in scope, and uses PKCE when the registration is a public client (`client-authentication-method: none`). For a confidential client add PKCE explicitly unless your version already enables it:

```java
@Bean
SecurityFilterChain app(HttpSecurity http, ClientRegistrationRepository registrations) throws Exception {
    DefaultOAuth2AuthorizationRequestResolver resolver =
        new DefaultOAuth2AuthorizationRequestResolver(registrations, "/oauth2/authorization");
    resolver.setAuthorizationRequestCustomizer(OAuth2AuthorizationRequestCustomizers.withPkce());

    http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .oauth2Login(login -> login.authorizationEndpoint(endpoint ->
            endpoint.authorizationRequestResolver(resolver)));
    return http.build();                      // session cookie in use: CSRF protection stays on
}
```

Do not write the flow by hand when a maintained client library exists.

## Tokens

| Token | Audience | Who reads it |
|-------|----------|--------------|
| ID token | The client | The client, once, to learn who logged in. Validate signature, `iss`, `aud` = client id, `exp`, `nonce` |
| Access token | The API | The resource server. Validate signature, `iss`, `aud`, `exp`, and `typ: at+jwt` where issued (RFC 9068) |
| Refresh token | The authorization server | Nobody else. Opaque to the client |

- **An ID token is not an access token.** An API that accepts ID tokens accepts tokens minted for any client of the same issuer.
- **Audience-restrict access tokens** to one resource server, and give them the smallest scope that works.
- **Refresh tokens of public clients are sender-constrained or rotated** (RFC 9700). Rotation: each refresh token is single-use, and reuse revokes the family (`jwt-security.md`). Sender-constraining: DPoP (RFC 9449) or mutual-TLS-bound tokens (RFC 8705), which also protect access tokens.
- Tokens never go in URLs or logs.

## Browser Applications: BFF

A script-readable token is stolen by any XSS. In the BFF pattern the browser never holds one:

```
Browser ──session cookie──▶ BFF (confidential client: code + PKCE, holds tokens)
                              └──Bearer access token──▶ API
```

- The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict`, `__Host-` prefixed.
- The BFF is cookie-authenticated, so it needs CSRF protection (`csrf-prevention.md`).
- The API stays a stateless resource server: it sees only bearer tokens, never cookies.

If a SPA must hold tokens itself: public client, code + PKCE, tokens in memory, short lifetimes, rotated refresh tokens, and a strict CSP (`security-headers.md`).

## Logout and Sessions

- Regenerate the application session on login (session fixation).
- Logout ends the local session and calls the provider's end-session endpoint with `id_token_hint`; register the post-logout redirect URI exactly.
- A stateless access token stays valid until `exp`; keep it short and revoke the refresh token.

## Quick Reference

| Do | Don't |
|----|-------|
| Authorization code + PKCE (`S256`) | Implicit grant, password grant |
| Exact redirect URIs | Wildcards, open redirects |
| Verify `state` and `nonce` | Accept a callback without them |
| BFF for SPAs | Tokens in `localStorage` |
| Access token with your `aud` at the API | ID token as API credential |
| Rotate or sender-constrain refresh tokens | Long-lived reusable refresh tokens for public clients |
| A maintained OAuth/OIDC library | A hand-written flow |
