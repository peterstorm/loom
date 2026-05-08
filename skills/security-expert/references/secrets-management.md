# Secrets Management Reference

## Core Principles

1. **Never hardcode secrets** in source code, config files, or container images
2. **Rotate regularly** — automate rotation where possible
3. **Least privilege** — each service gets only the secrets it needs
4. **Audit access** — log who/what accesses secrets and when

## Common Mistakes

```java
// NEVER: Hardcoded credentials
private static final String DB_PASSWORD = "super-secret-123";

// NEVER: In application.yml committed to git
spring:
  datasource:
    password: super-secret-123

// NEVER: In Dockerfile
ENV API_KEY=sk-live-abc123
```

## Environment Variables (Minimum Viable)

```yaml
# application.yml — reference env vars
spring:
  datasource:
    url: ${DB_URL}
    username: ${DB_USERNAME}
    password: ${DB_PASSWORD}

app:
  jwt:
    secret: ${JWT_SECRET}
  external-api:
    key: ${EXTERNAL_API_KEY}
```

```bash
# Set at deploy time, never in source
export DB_PASSWORD="$(vault kv get -field=password secret/db)"
```

### Limitations
- Visible in process listing (`/proc/*/environ`)
- Inherited by child processes
- Often logged by orchestrators
- No rotation without restart

## Spring Boot Externalized Config

### Spring Cloud Config + Vault
```yaml
# bootstrap.yml
spring:
  cloud:
    config:
      server:
        vault:
          host: vault.internal
          port: 8200
          scheme: https
          backend: secret
          default-key: application
```

### Spring Vault Integration
```java
@Configuration
public class VaultConfig {
    @Bean
    public VaultTemplate vaultTemplate(VaultEndpoint endpoint,
                                        ClientAuthentication auth) {
        return new VaultTemplate(endpoint, auth);
    }
}

@Service
public class SecretService {
    private final VaultTemplate vault;

    public String getDatabasePassword() {
        VaultResponseSupport<Map> response =
            vault.read("secret/data/myapp/db");
        return (String) response.getData().get("password");
    }
}
```

### Kubernetes Secrets
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
type: Opaque
data:
  db-password: base64-encoded-value
---
# Mount as env vars
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: app-secrets
        key: db-password

# Or mount as files (preferred — supports rotation)
volumes:
  - name: secrets
    secret:
      secretName: app-secrets
volumeMounts:
  - name: secrets
    mountPath: /etc/secrets
    readOnly: true
```

## Preventing Secret Leaks

### Git Prevention
```gitignore
# .gitignore
.env
*.pem
*.key
*.p12
*-secret*
credentials.json
```

```bash
# Pre-commit hook: scan for secrets
# Use gitleaks, truffleHog, or detect-secrets
gitleaks detect --source . --verbose
```

### Logging Prevention
```java
// Never log secrets
log.info("Connecting with password: {}", password); // NEVER

// Mask in toString()
public record DatabaseConfig(String url, String username, String password) {
    @Override
    public String toString() {
        return "DatabaseConfig[url=%s, username=%s, password=***]"
            .formatted(url, username);
    }
}

// Spring Boot: mask in actuator
management:
  endpoint:
    env:
      keys-to-sanitize: password,secret,key,token,credential
```

### Error Response Prevention
```yaml
# Never expose config in error responses
server:
  error:
    include-message: never
    include-stacktrace: never
```

## Key Rotation Pattern

```java
@Service
public class RotatingKeyService {
    private final VaultTemplate vault;
    private volatile KeyPair currentKeys;

    @Scheduled(fixedRate = 3600000) // Check hourly
    public void refreshKeys() {
        VaultResponse response = vault.read("secret/data/myapp/signing-key");
        String newKeyId = (String) response.getData().get("version");

        if (!newKeyId.equals(currentKeys.id())) {
            currentKeys = new KeyPair(
                newKeyId,
                (String) response.getData().get("private_key"),
                (String) response.getData().get("public_key")
            );
            log.info("Rotated signing key to version: {}", newKeyId);
        }
    }
}
```

## Quick Reference

| Method | Rotation | Audit | Complexity |
|--------|----------|-------|------------|
| Env vars | Restart required | None | Low |
| K8s Secrets | Volume mount auto-updates | K8s audit log | Medium |
| HashiCorp Vault | Dynamic secrets, auto-rotate | Full audit trail | High |
| AWS Secrets Manager | Auto-rotation with Lambda | CloudTrail | Medium |
