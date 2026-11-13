# Password Hashing Reference

Owner of password encoders and password policy. Other references link here.

## Algorithm Choice

Order follows the OWASP Password Storage Cheat Sheet.

| Algorithm | Use | Parameters (minimum) |
|-----------|-----|----------------------|
| **Argon2id** | First choice | 19 MiB memory, 2 iterations, parallelism 1; more memory where the server allows |
| **scrypt** | When Argon2id is unavailable | N=2^17, r=8, p=1 |
| **bcrypt** | Legacy systems, or when neither of the above is available | Work factor 10 or higher; input limited to 72 bytes |
| **PBKDF2** | When FIPS-140 compliance is required | PBKDF2-HMAC-SHA256, 600,000 iterations |
| SHA-256, SHA-1, MD5 (salted or not) | Never | Fast hashes are brute-forced cheaply |

Tune the cost so one verification takes roughly 100 to 500 ms on production hardware, and re-tune when hardware changes.

## Spring Security

```java
@Bean
public PasswordEncoder passwordEncoder() {
    Map<String, PasswordEncoder> encoders = Map.of(
        "argon2", new Argon2PasswordEncoder(16, 32, 1, 65536, 3),   // salt 16 B, hash 32 B, p=1, 64 MiB, t=3
        "bcrypt", new BCryptPasswordEncoder(12),
        "pbkdf2", Pbkdf2PasswordEncoder.defaultsForSpringSecurity_v5_8());

    DelegatingPasswordEncoder encoder = new DelegatingPasswordEncoder("argon2", encoders);
    // Hashes stored before the migration have no {id} prefix. Say what they are:
    encoder.setDefaultPasswordEncoderForMatches(new BCryptPasswordEncoder());
    return encoder;
}
```

- New hashes are written as `{argon2}...`. On verification the encoder is chosen by the stored `{id}` prefix.
- A stored hash without a prefix is not detected. Without `setDefaultPasswordEncoderForMatches`, matching it throws; either set the default as above or prefix the existing column once (`UPDATE users SET password = '{bcrypt}' || password`).
- The salt is generated and stored inside the hash; do not manage salts yourself.
- Argon2 in Spring Security needs Bouncy Castle on the classpath.

### Rehash on login
The plaintext is only available at login, so that is when an old hash is upgraded.

```java
public User authenticate(String username, String password) {
    User user = userRepo.findByUsername(username)
        .orElseThrow(() -> new BadCredentialsException("Invalid credentials"));

    if (!encoder.matches(password, user.getPasswordHash())) {
        throw new BadCredentialsException("Invalid credentials");
    }
    if (encoder.upgradeEncoding(user.getPasswordHash())) {        // old algorithm or weaker parameters
        user.setPasswordHash(encoder.encode(password));
        userRepo.save(user);
    }
    return user;
}
```
With Spring's `DaoAuthenticationProvider`, providing a `UserDetailsPasswordService` bean does this for you. To keep the response time from revealing whether the account exists, run `encoder.matches` against a dummy hash when the user is not found. Login throttling is in `owasp-api-security.md` (API2).

## Argon2 Without Spring (Bouncy Castle)

```java
byte[] salt = new byte[16];
new SecureRandom().nextBytes(salt);

Argon2Parameters params = new Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
    .withSalt(salt)
    .withParallelism(1)
    .withMemoryAsKB(65536)   // 64 MiB
    .withIterations(3)
    .build();

Argon2BytesGenerator generator = new Argon2BytesGenerator();
generator.init(params);
byte[] hash = new byte[32];
generator.generateBytes(password.toCharArray(), hash);
// store algorithm, parameters, salt and hash together; compare with MessageDigest.isEqual
```

## Password Policy

From NIST SP 800-63B revision 4:

- **Minimum length 15** when the password is the only factor; 8 is the floor when it is used together with a second factor.
- **Allow at least 64 characters**, all printable characters and spaces, and Unicode. Never truncate.
- **No composition rules** (required digits, upper case, symbols) and **no periodic expiry**. Force a change only on evidence of compromise.
- **Check new passwords against a blocklist** of common and breached passwords.

The same policy applies wherever passwords are set: application code, Keycloak (`keycloak.md`) and client-side form validation.

```java
public record PasswordPolicy(int minLength, int maxLength) {
    public static final PasswordPolicy DEFAULT = new PasswordPolicy(15, 128);
}

public void validatePassword(String password) {
    int length = password.codePointCount(0, password.length());
    if (length < policy.minLength()) throw new ValidationException("Password too short");
    if (length > policy.maxLength()) throw new ValidationException("Password too long");
    if (breachedPasswords.contains(password)) throw new ValidationException("Password found in a data breach");
}
```

**Maximum length and bcrypt.** An upper bound keeps a huge input from being used to burn hashing time; 128 is comfortable for Argon2id, scrypt and PBKDF2. bcrypt reads only the first 72 bytes, so with bcrypt a longer password is silently cut, which NIST forbids. If bcrypt is the encoder, reject passwords over 72 UTF-8 bytes (`password.getBytes(StandardCharsets.UTF_8).length`), which is below the 64-character allowance for non-ASCII text; that mismatch is a reason to move to Argon2id. Do not pre-hash with a plain digest to get around the limit.

### Breached-password check (Have I Been Pwned, k-anonymity)
Only the first five hex characters of the SHA-1 leave your server.

```java
public boolean isBreached(String password)
        throws IOException, InterruptedException, NoSuchAlgorithmException {
    byte[] digest = MessageDigest.getInstance("SHA-1").digest(password.getBytes(StandardCharsets.UTF_8));
    String sha1 = HexFormat.of().withUpperCase().formatHex(digest);
    String prefix = sha1.substring(0, 5);
    String suffix = sha1.substring(5);

    HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.pwnedpasswords.com/range/" + prefix))
        .header("Add-Padding", "true")
        .timeout(Duration.ofSeconds(3))
        .build();
    String body = httpClient.send(request, HttpResponse.BodyHandlers.ofString()).body();

    // Lines are SUFFIX:COUNT; padding lines have count 0
    return body.lines().anyMatch(line -> line.startsWith(suffix + ":") && !line.endsWith(":0"));
}
```
Decide what happens when the service is unreachable (reject, or accept and re-check later) and write it down; do not let the exception decide.

## Quick Reference

| Do | Don't |
|----|-------|
| Argon2id; scrypt, bcrypt or PBKDF2 only for the reasons above | SHA-256, MD5, SHA-1, with or without salt |
| Cost tuned to 100–500 ms | Fast hashing |
| `DelegatingPasswordEncoder`, rehash on login | A hard switch that invalidates existing hashes |
| Min 15 characters (8 with MFA), allow 64+, blocklist | Composition rules, forced rotation |
| Reject over-long input explicitly | Silent truncation (bcrypt beyond 72 bytes) |
| Same policy in app, identity provider and UI | Different rules per layer |
