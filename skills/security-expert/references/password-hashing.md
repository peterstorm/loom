# Password Hashing Reference

## Algorithm Choice

| Algorithm | Recommendation | Notes |
|-----------|---------------|-------|
| **Argon2id** | Best choice | Memory-hard, GPU/ASIC resistant. Winner of Password Hashing Competition |
| **bcrypt** | Good default | Well-tested, widely available. 72-byte input limit |
| **scrypt** | Good | Memory-hard. Less adoption than Argon2 |
| **PBKDF2** | Acceptable | NIST approved. Not memory-hard — weaker against GPU attacks |
| SHA-256/MD5 | NEVER | Fast hashes are trivially brute-forced |

## Spring Security (Default: bcrypt)

```java
@Bean
public PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder(12); // Cost factor 12 (2^12 iterations)
}

// Usage — Spring handles salt automatically
String hash = passwordEncoder.encode("user-password");
boolean matches = passwordEncoder.matches("user-password", hash);
```

### Upgrading Algorithm (Delegating Encoder)
```java
@Bean
public PasswordEncoder passwordEncoder() {
    String defaultEnc = "argon2";
    Map<String, PasswordEncoder> encoders = Map.of(
        "argon2", new Argon2PasswordEncoder(16, 32, 1, 65536, 3),
        "bcrypt", new BCryptPasswordEncoder(12),
        "pbkdf2", Pbkdf2PasswordEncoder.defaultsForSpringSecurity_v5_8()
    );

    return new DelegatingPasswordEncoder(defaultEnc, encoders);
    // New passwords: Argon2
    // Old passwords: auto-detected by prefix {bcrypt}, {pbkdf2}
    // Transparently rehashes on next login
}
```

### Transparent Rehashing on Login
```java
@Service
public class AuthService {
    private final PasswordEncoder encoder;
    private final UserRepository userRepo;

    public User authenticate(String username, String password) {
        User user = userRepo.findByUsername(username)
            .orElseThrow(() -> new BadCredentialsException("Invalid credentials"));

        if (!encoder.matches(password, user.getPasswordHash())) {
            throw new BadCredentialsException("Invalid credentials");
        }

        // Rehash if using old algorithm
        if (encoder.upgradeEncoding(user.getPasswordHash())) {
            user.setPasswordHash(encoder.encode(password));
            userRepo.save(user);
        }

        return user;
    }
}
```

## Argon2 Direct Usage (Non-Spring)

```java
// Using Bouncy Castle
Argon2BytesGenerator generator = new Argon2BytesGenerator();
Argon2Parameters params = new Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
    .withSalt(secureRandomSalt(16))
    .withParallelism(1)
    .withMemoryAsKB(65536)  // 64MB
    .withIterations(3)
    .build();

generator.init(params);
byte[] hash = new byte[32];
generator.generateBytes(password.toCharArray(), hash);
```

## Password Policy

```java
public record PasswordPolicy(
    int minLength,          // >= 12 (NIST 800-63B)
    int maxLength,          // 128 (prevent DoS on hashing)
    boolean checkBreached   // Check against HaveIBeenPwned
) {
    public static final PasswordPolicy DEFAULT = new PasswordPolicy(12, 128, true);
}

public void validatePassword(String password) {
    if (password.length() < policy.minLength()) {
        throw new ValidationException("Password too short");
    }
    if (password.length() > policy.maxLength()) {
        throw new ValidationException("Password too long");
    }
    // NIST recommends checking breached passwords, NOT complexity rules
    if (policy.checkBreached() && isBreached(password)) {
        throw new ValidationException("Password found in data breach");
    }
}

// Check HaveIBeenPwned using k-anonymity (safe, doesn't send full hash)
private boolean isBreached(String password) {
    String sha1 = DigestUtils.sha1Hex(password).toUpperCase();
    String prefix = sha1.substring(0, 5);
    String suffix = sha1.substring(5);

    // Only sends first 5 chars of hash
    String response = httpClient.get("https://api.pwnedpasswords.com/range/" + prefix);
    return response.contains(suffix);
}
```

## Quick Reference

| Do | Don't |
|----|-------|
| Argon2id or bcrypt | SHA-256, MD5, SHA-1 |
| Cost factor that takes 100-500ms | Fast hashing (<10ms) |
| Let framework handle salting | Manual salt management |
| Check breached passwords (NIST) | Enforce complexity rules (outdated) |
| Max length 128 (prevent hash DoS) | Unlimited password length |
| DelegatingPasswordEncoder for migration | Hard-switch that breaks existing hashes |
