---
name: security-expert
version: 1.0.0
description: "This skill should be used when the user asks to 'secure my API', 'implement authentication', 'configure Keycloak', 'add authorization', 'fix JWT issues', 'set up OAuth', 'review security', 'security audit', 'pen test prep', 'prevent SQL injection', 'fix XSS', 'CSRF protection', 'prevent command injection', 'file upload security', 'password hashing', 'secrets management', 'fix deserialization', 'prevent XXE', or works with JWT tokens, OAuth 2.0/OIDC flows, Spring Security, ABAC/RBAC policies, CORS, CSRF, XSS, SQL injection, command injection, path traversal, deserialization attacks, XXE, file upload validation, password hashing, secrets/credentials management, OWASP guidelines, or debugging auth failures in Spring/Keycloak environments. NOT for infrastructure security, network security, container hardening, or cloud IAM policies."
---

# Security Expert Skill

Expert guidance for API security, authentication, authorization, and identity management.

## Reference Routing

Load the reference that matches the user's problem:

| User needs | Load reference |
|------------|---------------|
| JWT issues, token validation, storage | `references/jwt-security.md` |
| Keycloak setup, realms, mappers, flows | `references/keycloak.md` |
| Spring Security filter chain, OAuth2 config | `references/spring-security.md` |
| RBAC vs ABAC, policy engines | `references/authorization-patterns.md` |
| Security audit, threat modeling | `references/owasp-api-security.md` |
| CORS, CSP, security headers | `references/security-headers.md` |
| SQL injection, parameterized queries | `references/injection-prevention.md` |
| XSS, DOMPurify, React sanitization | `references/xss-prevention.md` |
| CSRF tokens, SameSite cookies | `references/csrf-prevention.md` |
| Java deserialization, Jackson polymorphic typing | `references/deserialization-attacks.md` |
| File path manipulation, directory traversal | `references/path-traversal.md` |
| OS command execution with user input | `references/command-injection.md` |
| XML parsing, SOAP, DTD attacks | `references/xxe-prevention.md` |
| Upload validation, zip bombs, magic bytes | `references/file-upload-security.md` |
| Credentials, env vars, Vault, key rotation | `references/secrets-management.md` |
| bcrypt, Argon2, password policy, rehashing | `references/password-hashing.md` |

## Workflow: Security Review

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
