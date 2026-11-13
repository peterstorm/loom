# Keycloak Reference

Protocol rules (which flow, PKCE, redirect URIs, refresh tokens) are in `oauth-oidc.md`; token validation is in `jwt-security.md`. This file is the Keycloak configuration that implements them.

## Core Concepts

- **Realm**: an isolated tenant with its own users, roles and clients. Never use the `master` realm for applications.
- **Client**: an application registered in a realm, with its redirect URIs and enabled flows.
- **Roles**: realm roles (all clients), client roles (one client), composite roles.
- **Endpoints** live under the realm: issuer `https://keycloak.example.com/realms/{realm}`, then `/protocol/openid-connect/auth`, `/token`, `/certs`.

## Clients

### Confidential client (server-side web app, BFF)
```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-id: my-backend
            client-secret: ${KEYCLOAK_SECRET}
            authorization-grant-type: authorization_code
            scope: openid, profile
        provider:
          keycloak:
            issuer-uri: https://keycloak.example.com/realms/myrealm
```

### Public client (mobile app, SPA without a backend)
No secret. Authorization code flow with PKCE (`S256`), `state` and `nonce`. Use a maintained library (`keycloak-js`, `oidc-client-ts`); if you build the request yourself, the challenge is base64url of the SHA-256 digest, not the hex digest:

```typescript
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

const codeVerifier = random();
const state = random();          // compared with the state on the callback
const nonce = random();          // compared with the nonce claim of the ID token
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));

const authUrl = `${issuer}/protocol/openid-connect/auth?` + new URLSearchParams({
  client_id: 'my-spa',
  response_type: 'code',
  redirect_uri: 'https://app.example.com/callback',
  scope: 'openid profile',
  state,
  nonce,
  code_challenge: b64url(new Uint8Array(digest)),
  code_challenge_method: 'S256',
});
```

For a browser SPA prefer a BFF over a public client (see `oauth-oidc.md`).

### Client settings to enforce
```json
{
  "clientId": "my-spa",
  "publicClient": true,
  "standardFlowEnabled": true,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "redirectUris": ["https://app.example.com/callback"],
  "webOrigins": ["https://app.example.com"],
  "attributes": { "pkce.code.challenge.method": "S256" }
}
```
- Redirect URIs are exact. No `*`, no pattern covering paths you do not own.
- **Direct access grants (resource owner password credentials) stay off.** RFC 9700 says this grant must not be used: the client handles the password, and MFA and federation cannot work.
- Implicit flow stays off.

### Resource server (API)
An API that only validates tokens does not need to be able to log anyone in. The old "bearer-only" access type is not offered by the current admin console; register a client with every flow disabled so there is something to name as audience and to attach client roles to.

### Service to service
```bash
curl -X POST "https://keycloak.example.com/realms/myrealm/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=my-service" \
  -d "client_secret=${SECRET}"
```

## Protocol Mappers

### Audience mapper (required for APIs)
Without it the access token does not name your API in `aud`, and audience validation either fails or gets switched off.
```json
{
  "name": "api-audience",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-audience-mapper",
  "config": {
    "included.client.audience": "my-api",
    "id.token.claim": "false",
    "access.token.claim": "true"
  }
}
```

### Realm roles
```json
{
  "name": "realm-roles",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-realm-role-mapper",
  "config": {
    "claim.name": "roles",
    "jsonType.label": "String",
    "multivalued": "true",
    "access.token.claim": "true"
  }
}
```

### User attributes
```json
{
  "name": "department",
  "protocol": "openid-connect",
  "protocolMapper": "oidc-usermodel-attribute-mapper",
  "config": {
    "claim.name": "department",
    "user.attribute": "department",
    "access.token.claim": "true"
  }
}
```

Two conditions before an attribute is used for authorization:
- **Declare it in the realm's User Profile.** Since Keycloak 24 the declarative user profile is on by default and unmanaged attributes are ignored unless the realm's unmanaged-attribute policy says otherwise.
- **Make it admin-only.** Give the attribute `"permissions": { "view": ["admin"], "edit": ["admin"] }` (add `"user"` to `view` only if users may see it). An attribute a user can edit in the account console and that an API reads as `department` or `clearance` lets users grant themselves access.

## Realm Configuration

### Login protection
```json
{
  "sslRequired": "all",
  "bruteForceProtected": true,
  "permanentLockout": false,
  "failureFactor": 5,
  "waitIncrementSeconds": 60,
  "maxFailureWaitSeconds": 900,
  "minimumQuickLoginWaitSeconds": 60,
  "quickLoginCheckMilliSeconds": 1000,
  "maxDeltaTimeSeconds": 43200
}
```

### Token lifespans and refresh rotation
```json
{
  "accessTokenLifespan": 300,
  "ssoSessionIdleTimeout": 1800,
  "ssoSessionMaxLifespan": 36000,
  "accessCodeLifespan": 60,
  "revokeRefreshToken": true,
  "refreshTokenMaxReuse": 0
}
```
`revokeRefreshToken` with `refreshTokenMaxReuse: 0` makes each refresh token single-use.

### Password policy
Follow `password-hashing.md`: length and a denylist, no composition rules, no forced rotation. In Authentication → Policies → Password policy add:

- Minimum length 15 (8 is acceptable only where MFA is required for every login)
- Maximum length 64 or more
- Not username, not email
- The password denylist policy, with a list of common and breached passwords

Do not add digit, upper-case, lower-case or special-character rules, and do not add password expiry.

## Spring Integration

### Resource server
```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://keycloak.example.com/realms/myrealm
          audiences: my-api
```
The JWKS URI is discovered from the issuer. The decoder and its validators are described in `jwt-security.md`.

### Roles from `realm_access.roles`
```java
public class KeycloakRoleConverter implements Converter<Jwt, Collection<GrantedAuthority>> {
    @Override
    public Collection<GrantedAuthority> convert(Jwt jwt) {
        Map<String, Object> realmAccess = jwt.getClaimAsMap("realm_access");
        if (realmAccess == null || !(realmAccess.get("roles") instanceof Collection<?> roles)) {
            return List.of();
        }
        return roles.stream()
            .map(role -> (GrantedAuthority) new SimpleGrantedAuthority("ROLE_" + role.toString().toUpperCase(Locale.ROOT)))
            .toList();
    }
}

// wire it in
JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
converter.setJwtGrantedAuthoritiesConverter(new KeycloakRoleConverter());
http.oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> jwt.jwtAuthenticationConverter(converter)));
```

### Several realms (multi-tenant)
Each realm signs with its own keys. One decoder with one JWKS URI and a list of allowed issuers rejects every other realm's tokens at signature verification. Resolve the decoder from the issuer, from a fixed list:

```java
JwtIssuerAuthenticationManagerResolver resolver = JwtIssuerAuthenticationManagerResolver.fromTrustedIssuers(
    "https://keycloak.example.com/realms/tenant1",
    "https://keycloak.example.com/realms/tenant2");

http.oauth2ResourceServer(oauth2 -> oauth2.authenticationManagerResolver(resolver));
```
The list is the allowlist. Never build a decoder from whatever `iss` a token carries. After authentication, check that the token's realm matches the tenant of the resource being accessed.
