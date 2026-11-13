# SQL Injection Prevention Reference

## The Attack

User input is concatenated into a query and changes its structure.

```java
// VULNERABLE
String sql = "SELECT * FROM users WHERE username = '" + username + "'";
// username = admin' OR '1'='1   →   ... WHERE username = 'admin' OR '1'='1'
```

Variants: `UNION SELECT` to read other tables, boolean or time-based blind extraction, stacked statements, and second-order injection, where a value stored safely is later concatenated into another query. Data read back from your own database is as untrusted as the request it came from.

## The Three Rules

1. **Bind values as parameters.** Always, including values from the database.
2. **Allowlist identifiers.** Table names, column names and sort directions cannot be bound; map user input to a fixed set.
3. **Escape LIKE wildcards** when the user's text must match literally.

### 1. Bind parameters

```java
// JdbcTemplate
jdbcTemplate.queryForObject("SELECT * FROM users WHERE username = ?", userMapper, username);

// Named parameters; collections expand to a parameter list
namedJdbcTemplate.query("SELECT * FROM users WHERE id IN (:ids)",
    new MapSqlParameterSource("ids", ids), userMapper);

// JPQL and native queries
entityManager.createQuery("SELECT u FROM User u WHERE u.email = :email", User.class)
    .setParameter("email", email)
    .getResultList();
```

Spring Data JPA binds for you in every form it offers:

```java
public interface UserRepository extends JpaRepository<User, Long> {
    List<User> findByEmailContaining(String email);                               // derived query

    @Query("SELECT u FROM User u WHERE u.username = :username")
    Optional<User> findByUsername(@Param("username") String username);

    @Query(value = "SELECT * FROM users WHERE username = :username", nativeQuery = true)
    Optional<User> findByUsernameNative(@Param("username") String username);

    @Query("SELECT u FROM User u WHERE u.status = :#{#filter.status}")            // SpEL result is bound, not spliced
    List<User> findWithFilter(@Param("filter") UserFilter filter);
}
```

`Specification`, the Criteria API, Querydsl and jOOQ's DSL also bind values. The ways to get injection back are string-built queries (`createQuery("..." + x)`, `createNativeQuery`, `String.format`, `JdbcTemplate` with a concatenated string) and escape hatches that take raw fragments (`JpaSort.unsafe`, jOOQ plain-SQL strings).

An `IN` list built by joining a `List<Long>` into the SQL text is not injectable, because the elements are numbers, but it is the pattern that becomes injectable the day the list holds strings. Use parameter expansion.

### 2. Allowlist identifiers

```java
public enum SortColumn {
    USERNAME("username"), CREATED("created_at"), EMAIL("email");

    private final String column;
    SortColumn(String column) { this.column = column; }
    String column() { return column; }
}

public List<User> list(SortColumn sort, boolean descending) {     // the request value is parsed to the enum at the boundary
    String sql = "SELECT * FROM users ORDER BY " + sort.column() + (descending ? " DESC" : " ASC");
    return jdbcTemplate.query(sql, userMapper);
}
```

Only constants from the enum reach the SQL text. The same applies to table names, schema names in multi-tenant setups, and `LIMIT`/`OFFSET` where the driver cannot bind them (parse to `int` and bound it).

### 3. LIKE patterns

A bound parameter cannot inject, but `%` and `_` in it still act as wildcards, which lets a user match everything or build expensive patterns. Escape them and name the escape character in the query; without the `ESCAPE` clause the escaping depends on the database.

```java
public List<User> search(String term) {
    String pattern = "%" + escapeLike(term) + "%";
    return jdbcTemplate.query("SELECT * FROM users WHERE name LIKE ? ESCAPE '!'", userMapper, pattern);
}

private static String escapeLike(String input) {
    return input.replace("!", "!!").replace("%", "!%").replace("_", "!_");
}
```

## Defence in Depth

- **Validate input at the boundary** (`@Valid`, typed DTOs, length limits). It narrows what reaches the query; it does not replace binding: `O'Brien` is a valid name.
- **Least privilege.** The application's database account has no DDL rights and only the tables it needs; a separate account runs migrations.
- **Errors.** Do not return database error text to the client; log it and alert on syntax errors, which are what probing looks like.

## Testing

```java
@Test
void injectionPayloadIsTreatedAsData() {
    userRepository.save(new User("alice", "alice@test.com"));
    userRepository.save(new User("O'Brien", "obrien@test.com"));

    assertThat(userRepository.findByUsername("' OR '1'='1")).isEmpty();      // literal, matches nobody
    assertThat(userRepository.findByUsername("O'Brien")).isPresent();        // quote handled, no SQL error
}
```

Static analysis that flags string-built queries (SpotBugs with FindSecBugs, Semgrep, CodeQL) catches more than payload tests do, because it finds the concatenation rather than guessing an input.

## Other Injection

The same rule holds for every interpreter: keep data out of the code channel.

| Kind | Rule |
|------|------|
| OS command | See `command-injection.md`. |
| Expression language (SpEL) | Never parse user input as an expression: `parser.parseExpression(userInput)` is code execution. If users must supply expressions, evaluate them in a `SimpleEvaluationContext`, which has no type references, constructors or bean access. |
| Server-side template | Users supply data for a template, never the template text or its name. A view name or template string built from input is template injection; choose templates from a fixed map (`path-traversal.md`). |
| LDAP | Build filters with Spring LDAP's `LdapQueryBuilder` (`query().where("uid").is(input)`), which encodes values; when a filter or DN is assembled by hand, encode with `LdapEncoder.filterEncode` and `LdapEncoder.nameEncode`. |
| NoSQL (MongoDB) | Bind request fields to typed DTO fields (`String`, not `Object` or `Map`) so `{"$ne": null}` cannot arrive as an operator; build queries with `Criteria.where("f").is(value)`; never `$where` or a query assembled from a JSON string. |
| Log | Strip or encode CR and LF in logged values, or use a structured (JSON) encoder; never log secrets or tokens; keep the logging library patched and message lookups disabled. |

## Quick Reference

| Do | Don't |
|----|-------|
| Bind every value (`?`, `:name`, `@Param`, Criteria) | Concatenate or `String.format` values into SQL |
| Map sort and table names through an enum | Put request text in `ORDER BY` or `FROM` |
| Escape `%` and `_` and declare `ESCAPE` | Pass user text straight into a LIKE pattern |
| Treat stored data as untrusted | Concatenate values read from the database |
| Least-privilege database account | Application connecting as owner or superuser |
