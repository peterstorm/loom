# Java / Spring Boot Lint Setup

## Boundary Rules

Java projects use package imports (`import com.example.domain.Order;`). The boundary checker matches the full import specifier string against `deny`/`allow` lists using prefix matching.

### Hexagonal / Ports & Adapters Pattern

```json
{
  "boundaries": [
    {
      "module": "src/main/java/com/example/domain/",
      "allow": ["./", "java.", "javax.validation", "jakarta.validation"],
      "deny": [
        "com.example.infra",
        "com.example.api",
        "com.example.adapter",
        "org.springframework",
        "jakarta.persistence",
        "javax.persistence",
        "io.r2dbc",
        "org.jooq",
        "com.fasterxml.jackson"
      ]
    },
    {
      "module": "src/main/java/com/example/application/",
      "allow": ["./", "java.", "com.example.domain"],
      "deny": [
        "com.example.infra",
        "com.example.api",
        "org.springframework.web",
        "jakarta.servlet",
        "javax.servlet"
      ]
    },
    {
      "module": "src/main/java/com/example/infra/",
      "allow": ["./", "java.", "com.example.domain", "com.example.application", "org.springframework", "jakarta.persistence"],
      "deny": ["com.example.api"]
    }
  ]
}
```

### DDD Layered Pattern

```json
{
  "boundaries": [
    {
      "module": "src/main/java/com/example/domain/model/",
      "allow": ["./", "java.", "com.example.domain.model"],
      "deny": [
        "com.example.domain.service",
        "com.example.infrastructure",
        "com.example.application",
        "com.example.interfaces",
        "org.springframework",
        "jakarta.persistence"
      ]
    },
    {
      "module": "src/main/java/com/example/domain/service/",
      "allow": ["./", "java.", "com.example.domain"],
      "deny": [
        "com.example.infrastructure",
        "com.example.interfaces",
        "org.springframework.web",
        "org.springframework.data"
      ]
    },
    {
      "module": "src/main/java/com/example/application/",
      "allow": ["./", "java.", "com.example.domain", "org.springframework.stereotype", "org.springframework.transaction"],
      "deny": [
        "com.example.infrastructure",
        "com.example.interfaces",
        "org.springframework.web",
        "jakarta.servlet"
      ]
    }
  ]
}
```

### Multi-module Maven/Gradle

For multi-module projects, use the full path from repo root:

```json
{
  "boundaries": [
    {
      "module": "modules/domain/src/main/java/",
      "allow": ["./", "java."],
      "deny": ["com.example.infra", "com.example.api", "org.springframework"]
    },
    {
      "module": "modules/api/src/main/java/",
      "allow": ["./", "java.", "com.example.domain", "com.example.application", "org.springframework"],
      "deny": ["com.example.infra"]
    }
  ]
}
```

## Pure Modules

Paths that must be side-effect free. The checker detects:

| Banned Import | Why |
|---------------|-----|
| `java.io` | Filesystem I/O |
| `java.nio.file` | Filesystem I/O |
| `java.net` | Network I/O |
| `java.sql`, `javax.sql` | Database I/O |
| `jakarta.servlet`, `javax.servlet` | HTTP I/O |
| `java.lang.ProcessBuilder` | Process spawning |

### Example pureModules config

```json
{
  "pureModules": [
    "src/main/java/com/example/domain/model/",
    "src/main/java/com/example/domain/service/",
    "src/main/java/com/example/domain/vo/"
  ]
}
```

**Note:** `java.util`, `java.time`, `java.math` are NOT flagged — they're pure computation.

## Regex Rules — Java

### Default rules (already active from loom)

These fire automatically — no project config needed:

| Rule | What it catches | Fix |
|------|-----------------|-----|
| `no-field-injection` | `@Autowired`/`@Inject` on fields | Use constructor injection |
| `no-null-return` | `return null;` | Return `Optional.empty()` or throw |
| `no-raw-exception-catch` | `catch (Exception e)` | Catch specific types |
| `no-star-import` | `import com.example.*;` | Use explicit imports |
| `no-system-out` | `System.out.println()` | Use SLF4J logger |

### Rules to consider enabling

**no-mutable-entity-fields.json** (disabled by default) — enforces immutable domain model. Enable for DDD projects using records or @Value:

```json
{
  "kind": "regex",
  "name": "no-mutable-entity-fields",
  "description": "Block non-final instance fields in domain classes — use records or final fields",
  "extensions": [".java"],
  "pattern": "^\\s+(private|protected)\\s+(?!static|final|transient)[A-Z][\\w]*\\s+\\w+\\s*[;=]",
  "flags": "",
  "fixHint": "Make this field final, or convert the class to a Java record. Mutable fields break DDD invariants.",
  "enabled": true
}
```

### Recommended project rules

**no-lombok-data.json** — Block `@Data` (generates setters, breaks immutability):
```json
{
  "kind": "regex",
  "name": "no-lombok-data",
  "description": "Disallow @Data — use @Value or records for immutable types",
  "extensions": [".java"],
  "pattern": "^\\s*@Data\\b",
  "flags": "",
  "fixHint": "Replace @Data with @Value (immutable) or convert to a Java record. @Data generates setters which break domain invariants.",
  "enabled": true
}
```

**no-spring-component-scan.json** — Block broad component scanning:
```json
{
  "kind": "regex",
  "name": "no-spring-component-scan",
  "description": "Disallow @ComponentScan — use explicit @Bean configuration",
  "extensions": [".java"],
  "pattern": "@ComponentScan\\b",
  "flags": "",
  "fixHint": "Remove @ComponentScan and register beans explicitly via @Configuration/@Bean. Component scanning makes dependencies implicit and breaks testability.",
  "enabled": true
}
```

**no-service-annotation-in-domain.json** — Block Spring in domain:
```json
{
  "kind": "regex",
  "name": "no-service-annotation-in-domain",
  "description": "Disallow Spring annotations in domain layer",
  "extensions": [".java"],
  "pattern": "@(Service|Component|Repository|Controller|RestController)\\b",
  "flags": "",
  "fixHint": "Domain classes must not use Spring annotations. Spring wiring belongs in the configuration/infra layer. Use plain classes with constructor injection.",
  "enabled": true,
  "excludePatterns": ["/infra/", "/api/", "/adapter/", "/config/"]
}
```

**Note:** The `excludePatterns` uses `endsWith` matching, so `/infra/` matches any file whose path contains that segment.

## Function Length

```json
{
  "maxFunctionLines": 40,
  "excludeFromMaxLines": ["Test.java", "IT.java", "Tests.java"]
}
```

Java methods are typically more verbose than TypeScript — 40 lines is recommended. Test classes are excluded since test methods with setup/assertions tend to be longer.
