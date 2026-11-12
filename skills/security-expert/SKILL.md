---
name: security-expert
version: 1.0.0
description: "This skill should be used when the user asks to 'secure my API', 'implement authentication', 'configure Keycloak', 'add authorization', 'fix JWT issues', 'set up OAuth', 'prevent SQL injection', 'fix XSS', 'CSRF protection', 'prevent SSRF', 'prevent command injection', 'file upload security', 'password hashing', 'secrets management', 'fix deserialization', 'prevent XXE', 'make this retry-safe', or works with JWT tokens, OAuth 2.0/OIDC flows, Spring Security, ABAC/RBAC policies, CORS, CSRF, XSS, SQL injection, SSRF, command injection, path traversal, deserialization attacks, XXE, file upload validation, password hashing, secrets/credentials management, idempotency keys, OWASP guidelines, or debugging auth failures in Spring/Keycloak environments. NOT for repository-wide audits (use the `security-audit` skill). NOT for infrastructure security, network security, container hardening, or cloud IAM policies."
---

# Security Expert Skill

Guidance for writing and fixing security-sensitive code: API security, authentication, authorization, input handling and identity management.

## Context Loading

When implementing or modifying code (not only advising), read and apply the binding project rules:
- `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` — FC/IS, DDD, immutability, Either-based errors, ports at I/O boundaries (always)
- `${CLAUDE_PLUGIN_ROOT}/rules/typescript-patterns.md` (TypeScript) or `${CLAUDE_PLUGIN_ROOT}/rules/java-patterns.md` (Java) — language patterns

These constrain how security-sensitive code is structured; the wave-gate review agents enforce them.

## Reference Routing

Load the reference that matches the problem. Each topic has one owner; the others link to it.

| User needs | Load reference |
|------------|---------------|
| JWT validation, token storage, refresh rotation | `references/jwt-security.md` |
| OAuth 2.0 / OIDC flows, PKCE, redirect URIs, BFF | `references/oauth-oidc.md` |
| Keycloak setup, realms, clients, mappers | `references/keycloak.md` |
| Spring Security filter chain, resource server, method security | `references/spring-security.md` |
| RBAC vs ABAC vs ReBAC, `PermissionEvaluator`, policy engines | `references/authorization-patterns.md` |
| OWASP API Top 10 checklist, object-level authorization, login throttling | `references/owasp-api-security.md` |
| SSRF, outbound requests to user-supplied URLs, webhooks | `references/ssrf.md` |
| CORS, CSP, security headers, cookie attributes | `references/security-headers.md` |
| SQL injection; pointers for SpEL, LDAP, NoSQL, log injection | `references/sql-injection.md` |
| XSS, HTML sanitization, URL handling in React | `references/xss-prevention.md` |
| CSRF tokens, SameSite cookies, Fetch Metadata | `references/csrf-prevention.md` |
| Java deserialization, Jackson polymorphic typing, Redis serializers | `references/deserialization-attacks.md` |
| File path manipulation, directory traversal | `references/path-traversal.md` |
| OS command execution with user input | `references/command-injection.md` |
| XML parsing, SOAP, DTD attacks | `references/xxe-prevention.md` |
| Upload validation, zip bombs, serving user files | `references/file-upload-security.md` |
| Credentials, env vars, Vault, key rotation | `references/secrets-management.md` |
| Argon2, bcrypt, password policy, rehashing | `references/password-hashing.md` |
| Retries, idempotency keys, double charges, webhook dedup | `references/idempotency.md` |

## Workflow: Security Review

For reviewing a change or a feature. A whole-repository audit is the `security-audit` skill's job.

1. **Identify attack surface**: Public endpoints, auth flows, data exposure
2. **Check authentication**: Token validation, session handling, credential storage
3. **Check authorization**: Access control at endpoint and resource level
4. **Review data handling**: Input validation, output encoding, sensitive data exposure
5. **Examine configuration**: Security headers, CORS, error handling, logging
6. **Test edge cases**: Token expiry, concurrent sessions, privilege escalation

## Debugging Auth Failures

Check in order:
1. Token format/encoding — valid JWT structure?
2. Signature — correct algorithm and key?
3. Claims — exp, iss, aud correct?
4. Role/scope mapping — Keycloak mappers configured?
5. Filter chain — `logging.level.org.springframework.security=DEBUG`
