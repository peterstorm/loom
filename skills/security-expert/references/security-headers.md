# Security Headers Reference

Owner of response headers, Content Security Policy, CORS and cookie attributes. `SameSite` semantics are in `csrf-prevention.md`.

## Essential Headers

| Header | Purpose | Recommended Value |
|--------|---------|-------------------|
| `Strict-Transport-Security` | Force HTTPS | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | Prevent MIME sniffing | `nosniff` |
| `X-Frame-Options` | Prevent clickjacking (legacy; `frame-ancestors` is the CSP form) | `DENY` |
| `Content-Security-Policy` | Control resource loading | See CSP section |
| `Referrer-Policy` | Control referrer info | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | Control browser features | `geolocation=(), camera=(), microphone=()` |
| `Cache-Control` | Prevent sensitive data caching | `no-store` for sensitive responses |
| `Cross-Origin-Opener-Policy` | Isolate the window from cross-origin openers | `same-origin` |
| `Cross-Origin-Resource-Policy` | Stop other sites embedding your resources | `same-origin` (or `same-site`) |
| `Cross-Origin-Embedder-Policy` | Needed for cross-origin isolation (`SharedArrayBuffer`); breaks embeds that do not opt in | `require-corp`, only if required |

HSTS notes: browsers ignore the header on plain HTTP. `preload` is a commitment for the whole domain and every subdomain and is slow to undo; add it only when all of them serve HTTPS. `X-XSS-Protection` should be `0` or absent; the browser filter it controlled is gone.

## Content Security Policy

### API (no HTML)
```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
```

### Web application
```
Content-Security-Policy:
    default-src 'self';
    script-src 'self' 'nonce-<per-response random>' 'strict-dynamic';
    style-src 'self' https://fonts.googleapis.com;
    font-src 'self' https://fonts.gstatic.com;
    img-src 'self' data: https://cdn.example.com;
    connect-src 'self' https://api.example.com;
    object-src 'none';
    frame-ancestors 'none';
    form-action 'self';
    base-uri 'self';
    upgrade-insecure-requests
```
Google Fonts serves the stylesheet from `fonts.googleapis.com` and the font files from `fonts.gstatic.com`.

| Source value | Meaning |
|--------------|---------|
| `'self'` | Same origin |
| `'none'` | Nothing |
| `'nonce-<value>'` | Elements carrying this nonce attribute; the value is new for every response |
| `'strict-dynamic'` | Scripts loaded by a trusted script are trusted |
| `'unsafe-inline'`, `'unsafe-eval'` | Removes most of the protection; avoid in `script-src` |

A nonce only works if it is generated per response and placed in both the header and the tags. A fixed string such as `'nonce-{nonce}'` in a static header matches nothing, and a reused nonce protects nothing.

Emit the policy from one place. Two components that each set `Content-Security-Policy` either overwrite each other or produce two policies that are both enforced.

### Nonce filter (Spring MVC, server-rendered pages)
```java
public final class CspNonceFilter extends OncePerRequestFilter {

    private static final SecureRandom RANDOM = new SecureRandom();

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        String nonce = Base64.getEncoder().encodeToString(bytes);

        request.setAttribute("cspNonce", nonce);                 // <script th:attr="nonce=${cspNonce}">
        response.setHeader("Content-Security-Policy",            // the whole policy, not only script-src
            "default-src 'self'; script-src 'self' 'nonce-" + nonce + "' 'strict-dynamic'; object-src 'none'; "
            + "base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
        chain.doFilter(request, response);
    }
}
```
With this filter, do not also configure `contentSecurityPolicy(...)` in the Spring Security DSL.

### Nonce in Next.js (App Router)
The nonce is generated per request in `proxy.ts` (named `middleware.ts`, exporting `middleware`, before Next.js 16) and must be set on the **request** headers, which is where rendering reads it, as well as on the response.

```ts
// proxy.ts
import { NextRequest, NextResponse } from 'next/server'

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ')

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}
```

Next.js reads the nonce from the request's CSP header and adds it to its own scripts. For your own `<Script>` tags, read it in a Server Component with `const nonce = (await headers()).get('x-nonce')` (`headers()` is async since Next.js 15) and pass `nonce={nonce}`. Pages must be dynamically rendered: a statically generated page has no request and so no nonce. A static site sets a nonce-free policy in `next.config.js` `headers()` instead, which then needs `'unsafe-inline'` for scripts or hash/SRI support.

### Reporting and rollout
Start with `Content-Security-Policy-Report-Only`, fix what is reported, then enforce.
```
Reporting-Endpoints: csp="https://app.example.com/csp-report"
Content-Security-Policy-Report-Only: default-src 'self'; report-to csp; report-uri /csp-report
```
`report-to` names an endpoint declared in `Reporting-Endpoints`; a header that declares endpoints without a `report-to` directive in the policy reports nothing. Keep `report-uri` for browsers without the Reporting API. In Spring: `.contentSecurityPolicy(csp -> csp.policyDirectives("...").reportOnly())`.

## CORS

CORS relaxes the same-origin policy for reading responses. It is not authentication, not authorization and not a CSRF defence.

```java
@Bean
CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration config = new CorsConfiguration();
    config.setAllowedOrigins(List.of("https://app.example.com", "https://admin.example.com"));   // exact origins
    config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE"));
    config.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Request-ID"));
    config.setExposedHeaders(List.of("X-Request-ID"));
    config.setAllowCredentials(true);
    config.setMaxAge(3600L);

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/api/**", config);
    return source;
}

// in the filter chain
http.cors(cors -> cors.configurationSource(corsConfigurationSource()));
```

Rules:
- With credentials, list exact origins. `*` is not allowed by browsers, and reflecting the request's `Origin` is the same thing done by hand.
- Do not use origin patterns such as `https://*.example.com` with credentials: any subdomain that is taken over or hosts user content then reads authenticated responses.
- `null` is never an allowed origin.
- Spring's CORS support adds `Vary: Origin`. If you set the header yourself for an allowlisted origin, add `Vary: Origin` too, or a shared cache serves one origin's response to another.

## Cookies

| Attribute | Purpose |
|-----------|---------|
| `Secure` | Sent over HTTPS only |
| `HttpOnly` | Not readable by script |
| `SameSite` | Limits cross-site sending; set it explicitly (`csrf-prevention.md`) |
| `Path`, `Domain` | Scope; omit `Domain` to keep the cookie host-only |
| `Max-Age` | Lifetime |

| Prefix | The browser requires |
|--------|----------------------|
| `__Secure-` | `Secure` |
| `__Host-` | `Secure`, `Path=/`, no `Domain`; cannot be set or overwritten by a subdomain |

```
Set-Cookie: __Host-SESSION=abc; Secure; HttpOnly; SameSite=Lax; Path=/
```
In Spring build cookies with `ResponseCookie.from(name, value).secure(true).httpOnly(true).sameSite("Lax").path("/")`. Session cookie properties (`server.servlet.session.cookie.*`) are shown in `csrf-prevention.md`.

## Spring Security Configuration

Spring Security writes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-cache, no-store`, `X-XSS-Protection: 0` and, on HTTPS requests only, `Strict-Transport-Security` by default. It sets no CSP. Add what is missing; do not restate or disable the defaults.

```java
http.headers(headers -> headers
    .contentSecurityPolicy(csp -> csp
        .policyDirectives("default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"))
    .referrerPolicy(referrer -> referrer
        .policy(ReferrerPolicyHeaderWriter.ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
    .permissionsPolicyHeader(permissions -> permissions          // 6.4+; permissionsPolicy(...) before that
        .policy("geolocation=(), microphone=(), camera=()"))
    .crossOriginOpenerPolicy(coop -> coop
        .policy(CrossOriginOpenerPolicyHeaderWriter.CrossOriginOpenerPolicy.SAME_ORIGIN))
    .crossOriginResourcePolicy(corp -> corp
        .policy(CrossOriginResourcePolicyHeaderWriter.CrossOriginResourcePolicy.SAME_ORIGIN)));
```

Per response:
```java
return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(data);
```

### Testing
```java
@Test
void securityHeadersArePresent() throws Exception {
    mockMvc.perform(get("/api/test").secure(true))               // HSTS is written only for secure requests
        .andExpect(header().string("Strict-Transport-Security", containsString("max-age=")))
        .andExpect(header().string("X-Content-Type-Options", "nosniff"))
        .andExpect(header().string("X-Frame-Options", "DENY"))
        .andExpect(header().exists("Content-Security-Policy"));
}
```
