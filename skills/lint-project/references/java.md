# Java / Spring Boot Lint Setup

Boundary and purity templates. The config fields, the rule schema and every shipped rule are in `${CLAUDE_PLUGIN_ROOT}/lint-rules/README.md`.

## Boundary Rules

A Java import (`import com.example.domain.Order;`) is matched as its package name against the boundary whose `module` holds the file: `deny` first, then `allow`. `allow` is a closed list, so name every library the layer may import. Classes in the same package need no import and are not checked.

The layers are the ones in `rules/java-patterns.md` → "Package Structure": `domain/`, `orchestrator/`, `infra/`, `api/` and `config/`. There is no `service` package.

<!-- wire-example: linter-project-config -->
```json
{
  "requireGovernance": ["src/main/java/com/example/"],
  "boundaries": [
    {
      "module": "src/main/java/com/example/domain/",
      "description": "Functional core: no Spring, no persistence, no I/O packages",
      "allow": ["java.", "com.example.domain"],
      "deny": [
        "java.io", "java.nio.file", "java.net", "java.sql", "javax.sql",
        "com.example.orchestrator", "com.example.infra", "com.example.api", "com.example.config",
        "org.springframework", "jakarta.persistence", "jakarta.servlet", "com.fasterxml.jackson"
      ]
    },
    {
      "module": "src/main/java/com/example/orchestrator/",
      "description": "Shell orchestrators: domain logic and ports, never adapters",
      "allow": [
        "java.", "com.example.domain", "com.example.orchestrator",
        "org.springframework.stereotype", "org.springframework.transaction"
      ],
      "deny": ["com.example.infra", "com.example.api", "org.springframework.web", "jakarta.servlet"]
    },
    {
      "module": "src/main/java/com/example/infra/",
      "description": "Adapters: implement the domain's ports with vendor SDKs",
      "allow": ["java.", "javax.sql", "com.example.domain", "com.example.infra", "org.springframework", "jakarta.persistence"],
      "deny": ["com.example.orchestrator", "com.example.api"]
    },
    {
      "module": "src/main/java/com/example/api/",
      "description": "REST controllers: parse, call an orchestrator, format",
      "allow": [
        "java.", "com.example.domain", "com.example.orchestrator", "com.example.api",
        "org.springframework", "jakarta.validation", "jakarta.servlet"
      ],
      "deny": ["com.example.infra"]
    },
    {
      "module": "src/main/java/com/example/config/",
      "description": "Spring configuration and bean wiring",
      "allow": ["java.", "com.example", "org.springframework"],
      "deny": []
    }
  ]
}
```

- `@Service` on an orchestrator is allowed: it is a Spring stereotype, and component scanning wires the adapters. That is why `orchestrator/` may import `org.springframework.stereotype`.
- The `deny` on `domain/` for `org.springframework` is what keeps Spring annotations out of the core. No separate regex rule is needed for it. Where a regex rule does have to skip a layer, give `excludePatterns` a directory entry: `/infra/` matches `…/com/shop/infra/Db.java` at a segment boundary and never `…/com/shop/infrastructure/Db.java`. An entry without the trailing slash is a file suffix (`Test.java`). Entries are matched against the path inside the project, so where the checkout lives never matters.
- Add the project's own libraries (its Either, Vavr, Lombok) to the `allow` list of each layer that uses them.

### Multi-module Maven / Gradle

Use the full path from the repository root as each `module`:

<!-- wire-example: linter-project-config -->
```json
{
  "boundaries": [
    {
      "module": "modules/domain/src/main/java/",
      "allow": ["java.", "com.example.domain"],
      "deny": ["java.io", "java.nio.file", "java.net", "java.sql", "com.example.infra", "com.example.api", "org.springframework"]
    },
    {
      "module": "modules/api/src/main/java/",
      "allow": ["java.", "com.example.domain", "com.example.orchestrator", "com.example.api", "org.springframework"],
      "deny": ["com.example.infra"]
    }
  ]
}
```

## Pure Modules

The functional core is pure by default inside its roots: every non-test file under a `pureModules` root is held to purity, including files added later. A shell that genuinely lives inside a root is declared in `impureModules` as `{ "path", "reason" }`, the reason being the I/O it does.

<!-- wire-example: linter-project-config -->
```json
{
  "pureModules": ["src/main/java/com/example/domain/"]
}
```

For Java the purity rule reports only ambient calls it can see in the text, such as `Math.random()` and `new Date()`. It does not read Java imports. Keep I/O packages out of the core with the `deny` entries on the `domain/` boundary above: `java.io`, `java.nio.file`, `java.net`, `java.sql`, `javax.sql`, `jakarta.servlet`. `java.util`, `java.time` and `java.math` are pure computation; inject a `Clock` instead of calling `Instant.now()`.

## Regex Rules

Active without configuration: `no-field-injection`, `no-null-return`, `no-raw-exception-catch`, `no-star-import`, `no-system-out`. `no-mutable-entity-fields` ships disabled; the README says how to enable it.

One project rule worth adding where Lombok is used:

<!-- wire-example: linter-regex-rule -->
```json
{
  "kind": "regex",
  "name": "no-lombok-data",
  "description": "Disallow @Data — use @Value or records for immutable types",
  "extensions": [".java"],
  "pattern": "^\\s*@Data\\b",
  "flags": "",
  "fixHint": "Replace @Data with @Value or convert the class to a record. @Data generates setters, which break domain invariants.",
  "enabled": true
}
```

## Function Length

<!-- wire-example: linter-project-config -->
```json
{
  "maxFunctionLines": 40,
  "excludeFromMaxLines": ["Test.java", "IT.java", "Tests.java"]
}
```

Java methods run longer than TypeScript functions; 40 lines is a reasonable limit. Test classes are excluded because a test method with setup and assertions is naturally long.
