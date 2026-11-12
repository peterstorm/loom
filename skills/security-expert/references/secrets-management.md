# Secrets Management Reference

## Core Principles

1. **Never hardcode secrets** in source code, committed config files or container images.
2. **Rotate**, and automate rotation where possible.
3. **Least privilege**: each service reads only the secrets it needs.
4. **Audit access**: log who or what read a secret and when.

## Common Mistakes

```java
// Hardcoded credential
private static final String DB_PASSWORD = "super-secret-123";
```
```yaml
# application.yml committed to git
spring:
  datasource:
    password: super-secret-123
```
```dockerfile
# Baked into an image layer
ENV API_KEY=sk-live-abc123
```

## Environment Variables (minimum viable)

```yaml
# application.yml references, never contains
spring:
  datasource:
    url: ${DB_URL}
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}
```

Limitations: readable by anything that can read the process environment (`/proc/<pid>/environ`), inherited by child processes, often captured by crash dumps and orchestrator tooling, and not rotatable without a restart. Clear the environment when starting child processes (`command-injection.md`).

## HashiCorp Vault

### Spring Cloud Vault (properties)
Spring Cloud Vault 3+ uses the Config Data API in `application.yml`; `bootstrap.yml` is the legacy mechanism. (`spring.cloud.config.server.vault` configures a Config Server backend, not a client.)

```yaml
spring:
  config:
    import: vault://
  cloud:
    vault:
      uri: https://vault.internal:8200
      authentication: KUBERNETES
      kubernetes:
        role: myapp
```

### Spring Vault (programmatic), KV version 2
KV v2 wraps the secret: the HTTP path has a `data/` segment and the payload sits under a nested `data` key. Reading `secret/data/myapp/db` with `vault.read(...)` and taking `getData().get("password")` therefore returns null. Use the versioned operations, which hide both.

```java
public String databasePassword() {
    Versioned<Map<String, Object>> secret =
        vault.opsForVersionedKeyValue("secret").get("myapp/db");        // mount "secret", path "myapp/db"
    if (secret == null) {
        throw new IllegalStateException("Secret myapp/db not found");
    }
    return (String) secret.getRequiredData().get("password");
}
```

Prefer dynamic secrets (database credentials issued per instance with a lease) over static ones where Vault supports the backend.

## Kubernetes Secrets

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
type: Opaque
data:
  db-password: c3VwZXItc2VjcmV0     # base64 is an encoding, not encryption
---
# Mounted as files (preferred: updates reach the pod without a restart)
volumes:
  - name: secrets
    secret:
      secretName: app-secrets
volumeMounts:
  - name: secrets
    mountPath: /etc/secrets
    readOnly: true
```

A Secret is only as protected as the cluster makes it: enable encryption at rest for etcd (or use a KMS provider or an external secret store), restrict `get`/`list` on secrets with RBAC, and keep Secret manifests out of git unless they are sealed or encrypted (Sealed Secrets, SOPS). Environment variables from `secretKeyRef` work but share the limitations above.

## Preventing Leaks

### Git
```gitignore
.env
*.pem
*.key
*.p12
credentials.json
```
```bash
# Pre-commit and CI: scan for secrets
gitleaks detect --source . --verbose
```
A secret that reached a remote is compromised. Rotate it; rewriting history is not enough.

### Logs
```java
// Never
log.info("Connecting with password: {}", password);

// Records print every component by default: mask it
public record DatabaseConfig(String url, String username, String password) {
    @Override
    public String toString() {
        return "DatabaseConfig[url=%s, username=%s, password=***]".formatted(url, username);
    }
}
```
Also keep tokens, API keys and idempotency keys out of request logs and URLs.

### Actuator and error responses
Since Spring Boot 3 the `env` and `configprops` endpoints sanitise every value by default (the old `keys-to-sanitize` property is gone). Leave it that way, or open values only to an administrative role:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    env:
      show-values: never            # never | when-authorized | always
server:
  error:
    include-message: never
    include-stacktrace: never
```

## Signing-Key Rotation

Rules:
- Verifiers must accept the old key for as long as tokens signed with it are valid. Publish the new public key before signing with it, and keep the old public key in the JWKS until the longest token lifetime has passed.
- Each key has a `kid`; tokens carry it so verifiers pick the right key.
- Load keys at startup and fail if none is available, then refresh on a schedule; a refresh that fails keeps the current keys.

```java
/** Immutable snapshot: the key used for signing plus every key still accepted for verification. */
public record SigningKeys(String activeKid, PrivateKey activeKey, Map<String, PublicKey> verificationKeys) {
    public SigningKeys {
        verificationKeys = Map.copyOf(verificationKeys);
        if (!verificationKeys.containsKey(activeKid)) {
            throw new IllegalArgumentException("Active key must also be a verification key");
        }
    }
}

private final AtomicReference<SigningKeys> keys;      // set in the constructor from the first successful load

@Scheduled(fixedRate = 3_600_000)
public void refresh() {
    try {
        keys.set(keySource.load());                   // port: reads current and previous key versions
    } catch (RuntimeException e) {
        log.warn("Signing key refresh failed; keeping current keys", e);
    }
}
```

For most services the identity provider signs tokens and handles this (Keycloak publishes every active realm key in its JWKS); resource servers only need a decoder that re-fetches the JWKS on an unknown `kid`, which Spring's `NimbusJwtDecoder` does.

## Quick Reference

| Method | Rotation | Audit | Complexity |
|--------|----------|-------|------------|
| Env vars | Restart required | None | Low |
| K8s Secrets (file mount) | Updated in the volume | K8s audit log | Medium |
| HashiCorp Vault | Dynamic secrets, leases | Full audit trail | High |
| Cloud secret manager (AWS, GCP, Azure) | Managed rotation | Provider audit log | Medium |
