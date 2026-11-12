# CSRF Prevention Reference

## The Attack

A page on another site makes the victim's browser send a state-changing request to your application. The browser attaches the victim's credentials by itself, so the request arrives authenticated.

```html
<!-- on evil.example -->
<form action="https://bank.example/api/transfer" method="POST">
  <input type="hidden" name="to" value="attacker"><input type="hidden" name="amount" value="10000">
</form>
<script>document.forms[0].submit()</script>
```

The attacker cannot read the response; the damage is the side effect.

## When Protection Is Needed

Protection is needed whenever a state-changing request is authenticated by something the browser sends automatically: a session cookie, a token stored in a cookie, HTTP Basic credentials or a client certificate.

| Credential | CSRF protection |
|------------|-----------------|
| Session cookie | Required |
| JWT or other token in a cookie (including `HttpOnly`) | Required |
| `Authorization: Bearer` header added by script, no cookie credential at all | Not needed |
| No authentication (public read-only endpoint) | Not needed |

**`csrf.disable()` is correct only if no credential is ever sent by cookie.** "It is a stateless API" is not the condition: a stateless API that reads its JWT from a cookie is as exposed as a session. `jwt-security.md` (token storage) and `spring-security.md` (resource server) repeat this condition where the choice is made.

CORS is not a CSRF defence. A cross-site form post is sent without any CORS check; CORS only decides whether the other site's script may read the response.

## Spring Security

CSRF protection is on by default and covers POST, PUT, PATCH and DELETE.

### Server-rendered forms: synchronizer token
The default. The token is stored in the HTTP session and written into each form; Thymeleaf adds the hidden `_csrf` field to every `th:action` form.

```java
http.csrf(Customizer.withDefaults());   // HttpSessionCsrfTokenRepository
```

### Single-page applications: cookie-to-header token
The server puts the token in a cookie that script can read; the SPA copies it into a request header. This is a double-submit pattern, not a synchronizer token.

```java
// Spring Security 7
http.csrf(csrf -> csrf.spa());
```

```java
// Spring Security 6.x
http.csrf(csrf -> csrf
    .csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
    .csrfTokenRequestHandler(new SpaCsrfTokenRequestHandler()));

final class SpaCsrfTokenRequestHandler implements CsrfTokenRequestHandler {
    private final CsrfTokenRequestHandler plain = new CsrfTokenRequestAttributeHandler();
    private final CsrfTokenRequestHandler xor = new XorCsrfTokenRequestAttributeHandler();

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response, Supplier<CsrfToken> csrfToken) {
        this.xor.handle(request, response, csrfToken);   // BREACH protection for tokens rendered in a body
        csrfToken.get();                                 // load the deferred token so the cookie is written
    }

    @Override
    public String resolveCsrfTokenValue(HttpServletRequest request, CsrfToken csrfToken) {
        String header = request.getHeader(csrfToken.getHeaderName());
        // Header: raw token copied from the cookie. Otherwise: the masked _csrf form parameter.
        return (StringUtils.hasText(header) ? this.plain : this.xor).resolveCsrfTokenValue(request, csrfToken);
    }
}
```
Without the `csrfToken.get()` call the token is deferred and the cookie is never sent, so the SPA has nothing to copy.

The client reads the `XSRF-TOKEN` cookie and sends its value in the `X-XSRF-TOKEN` header on every state-changing request (Angular and Axios do this by default; with `fetch`, add the header yourself).

**Limit of double submit.** The server only checks that cookie and header agree. An attacker who can set a cookie for your domain (a compromised or takeover-prone sibling subdomain, or a plain-HTTP response on the same domain) supplies both values. Mitigations: host the application on a domain whose subdomains you control, serve only HTTPS with HSTS (`security-headers.md`), name the cookie with the `__Host-` prefix (`setCookieName`, with `Secure`, `Path=/` and no `Domain`; update the SPA to read the new name), and where you build the mechanism yourself, use OWASP's signed variant (an HMAC over the session id and a random value). The session-stored synchronizer token does not have this weakness.

### Exemptions
```java
http.csrf(csrf -> csrf.ignoringRequestMatchers("/api/webhooks/**"));
```
Exempt only endpoints that carry no cookie credential and authenticate another way, for example webhooks verified by signature (`idempotency.md`). Prefer an exemption to disabling CSRF for the whole chain.

## SameSite Cookies

`SameSite` controls whether a cookie is sent on requests that originate from another site.

| Value | Cross-site subrequests and form posts | Cross-site top-level GET navigation |
|-------|---------------------------------------|-------------------------------------|
| `Strict` | Not sent | Not sent |
| `Lax` | Not sent | Sent |
| `None` (requires `Secure`) | Sent | Sent |

- **Set it explicitly.** Browsers differ in what they do when the attribute is missing, and the browsers that default to `Lax` still send such a cookie on cross-site POSTs for about two minutes after it was set.
- **"Site" is the registrable domain, not the origin.** `evil.example.com` and `app.example.com` are same-site, so SameSite does nothing against a hostile or compromised sibling subdomain.
- `Lax` sends the cookie on top-level GET navigations, so a GET must never change state.
- `Lax` is enough for OAuth and OIDC redirects back to your application (they are top-level GET navigations). `None` is needed only when your application is embedded or called from a different site, and it removes the protection.
- `Strict` logs the user out of the first request when they arrive from an external link; use it for cookies that guard sensitive actions.

```yaml
server:
  servlet:
    session:
      cookie:
        same-site: lax
        secure: true
        http-only: true
        name: __Host-SESSION
```

SameSite is defence in depth. Keep the token.

## Fetch Metadata

Current browsers send `Sec-Fetch-Site` on every request: `same-origin`, `same-site`, `cross-site` or `none` (typed URL, bookmark). Rejecting state-changing requests that are not same-origin stops CSRF without a token and covers endpoints a token misses. Fall back to the `Origin` header for browsers that do not send it.

```java
public final class FetchMetadataFilter extends OncePerRequestFilter {

    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS");
    private final Set<String> ownOrigins;                 // e.g. "https://app.example.com"

    public FetchMetadataFilter(Set<String> ownOrigins) {
        this.ownOrigins = Set.copyOf(ownOrigins);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!SAFE_METHODS.contains(request.getMethod()) && !isSameOrigin(request)) {
            response.sendError(HttpServletResponse.SC_FORBIDDEN);
            return;
        }
        chain.doFilter(request, response);
    }

    private boolean isSameOrigin(HttpServletRequest request) {
        String site = request.getHeader("Sec-Fetch-Site");
        if (site != null) {
            return site.equals("same-origin");            // same-site is refused: sibling subdomains are not trusted
        }
        String origin = request.getHeader("Origin");
        return origin != null && ownOrigins.contains(origin);   // neither header: refuse
    }
}
```
Apply it to cookie-authenticated routes. Non-browser clients send neither header, so routes they call with a bearer token need a separate filter chain.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `csrf.disable()` "because it is an API" while authentication is a cookie | Keep CSRF on, or move the credential to a header |
| GET that changes state (`/logout`, `/delete?id=`) | POST, PUT, PATCH or DELETE only |
| Token present in a cookie but never compared with a header or field | The server must require the token outside the cookie |
| Relying on SameSite or CORS alone | Token or Fetch Metadata check, SameSite on top |
| Login form without CSRF protection | Protect it: login CSRF signs the victim into the attacker's account |
| XSS anywhere on the origin | XSS defeats every CSRF defence; see `xss-prevention.md` |

## Testing

```java
@Test
void postWithoutTokenIsForbidden() throws Exception {
    mockMvc.perform(post("/api/users").with(user("alice"))
            .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"test\"}"))
        .andExpect(status().isForbidden());
}
```
The same request with `.with(csrf())` succeeds. Also assert that no GET handler has a side effect and that the session id and token change at login.
