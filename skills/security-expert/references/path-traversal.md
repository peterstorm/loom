# Path Traversal Prevention Reference

## The Attack

Attacker manipulates file paths to access files outside intended directory.

```
GET /api/files?name=../../../etc/passwd
GET /api/download/..%2F..%2F..%2Fetc%2Fpasswd
POST /api/upload  filename="../../webapps/ROOT/shell.jsp"
```

## Common Vulnerable Patterns

### File Download
```java
// VULNERABLE: User controls path
@GetMapping("/download")
public ResponseEntity<Resource> download(@RequestParam String filename) {
    Path file = Paths.get("/uploads/" + filename); // ../../etc/passwd
    Resource resource = new FileSystemResource(file);
    return ResponseEntity.ok().body(resource);
}
```

### File Upload
```java
// VULNERABLE: Using original filename
@PostMapping("/upload")
public void upload(@RequestParam MultipartFile file) {
    String filename = file.getOriginalFilename(); // Could be "../../evil.jsp"
    file.transferTo(new File("/uploads/" + filename));
}
```

### Template/Config Loading
```java
// VULNERABLE: User controls template name
@GetMapping("/report/{template}")
public String report(@PathVariable String template) {
    return templateEngine.process("reports/" + template, context);
}
```

## Prevention

### Canonical Path Validation
```java
public Path resolveSafePath(String userInput, Path baseDir) {
    Path resolved = baseDir.resolve(userInput).normalize();

    // Verify resolved path is still under base directory
    if (!resolved.startsWith(baseDir)) {
        throw new SecurityException("Path traversal attempt: " + userInput);
    }

    return resolved;
}

// Usage
@GetMapping("/download")
public ResponseEntity<Resource> download(@RequestParam String filename) {
    Path baseDir = Paths.get("/uploads").toRealPath();
    Path file = resolveSafePath(filename, baseDir);
    return ResponseEntity.ok().body(new FileSystemResource(file));
}
```

### Safe File Upload
```java
@PostMapping("/upload")
public String upload(@RequestParam MultipartFile file) {
    // Generate safe filename — never use original
    String extension = getValidExtension(file.getOriginalFilename());
    String safeName = UUID.randomUUID() + extension;

    Path target = Paths.get("/uploads").resolve(safeName);
    file.transferTo(target);
    return safeName;
}

private String getValidExtension(String filename) {
    if (filename == null) return "";
    String ext = filename.substring(filename.lastIndexOf('.'));

    // Allowlist extensions
    Set<String> allowed = Set.of(".pdf", ".png", ".jpg", ".csv");
    if (!allowed.contains(ext.toLowerCase())) {
        throw new BadRequestException("File type not allowed");
    }
    return ext;
}
```

### Input Sanitization
```java
public String sanitizeFilename(String input) {
    // Remove path separators and traversal sequences
    return input
        .replaceAll("[/\\\\]", "")     // Remove slashes
        .replaceAll("\\.\\.", "")       // Remove ..
        .replaceAll("[^a-zA-Z0-9._-]", ""); // Allowlist chars
}
```

### Spring Configuration
```java
// Disable path traversal in static resources
@Configuration
public class WebConfig implements WebMvcConfigurer {
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/files/**")
            .addResourceLocations("file:/uploads/")
            .resourceChain(true); // Enable resource chain for validation
    }
}
```

## Testing
```java
@Test
void shouldBlockPathTraversal() {
    List<String> payloads = List.of(
        "../etc/passwd",
        "..\\windows\\system32\\config\\sam",
        "....//....//etc/passwd",
        "%2e%2e%2fetc%2fpasswd",
        "..%252f..%252fetc%252fpasswd"
    );

    for (String payload : payloads) {
        assertThrows(SecurityException.class,
            () -> resolveSafePath(payload, baseDir),
            "Should block: " + payload);
    }
}
```
