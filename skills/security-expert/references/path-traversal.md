# Path Traversal Prevention Reference

## The Attack

The attacker supplies a path that resolves outside the intended directory.

```
GET /api/files?name=../../../etc/passwd
GET /api/files?name=/etc/passwd
POST /api/upload  filename="../../webapps/ROOT/shell.jsp"
```

## Vulnerable Patterns

```java
// VULNERABLE: user controls the path
@GetMapping("/download")
public ResponseEntity<Resource> download(@RequestParam String filename) {
    Path file = Paths.get("/uploads/" + filename);              // ../../etc/passwd
    return ResponseEntity.ok().body(new FileSystemResource(file));
}

// VULNERABLE: user controls the template name
@GetMapping("/report/{template}")
public String report(@PathVariable String template) {
    return templateEngine.process("reports/" + template, context);
}
```

Writing an upload under its original filename is the same bug; `file-upload-security.md` owns the upload handler.

## Prevention

### 1. Prefer an identifier over a path
Look the file up by an id you issued (a UUID column, a map of template names). The user never supplies a path segment, so there is nothing to traverse.

```java
private static final Map<String, String> TEMPLATES = Map.of(
    "monthly", "reports/monthly", "annual", "reports/annual");

String view = TEMPLATES.get(template);
if (view == null) throw new BadRequestException("Unknown report");
```

### 2. Parse a file name: reject, do not sanitise
Removing "bad" sequences is not safe. A filter that deletes `..` and then deletes other characters turns `. .` into `..`; deleting `../` once turns `....//` into `../`. Accept a strict shape or refuse the request.

```java
private static final Pattern SAFE_NAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$");

/** One path segment: no separators, no leading dot or dash. Returned unchanged or rejected. */
public static String parseFileName(String input) {
    if (input == null || !SAFE_NAME.matcher(input).matches()) {
        throw new BadRequestException("Invalid file name");
    }
    return input;
}
```

### 3. Containment check
`normalize()` is lexical: it removes `.` and `..` but knows nothing about symbolic links. Use it for paths that do not exist yet, and resolve the real path for files that do.

```java
/** Lexical check. baseDir must be absolute and normalized. Stops ../ and absolute input, not symlinks. */
public static Path resolveSafePath(String userInput, Path baseDir) {
    Path resolved = baseDir.resolve(userInput).normalize();
    if (!resolved.startsWith(baseDir)) {
        throw new SecurityException("Path escapes base directory");
    }
    return resolved;
}

/** For a file that exists: follow symlinks, then check again. */
public static Path resolveExistingFile(String userInput, Path baseDir) throws IOException {
    Path realBase = baseDir.toRealPath();
    Path real = resolveSafePath(userInput, realBase).toRealPath();   // NoSuchFileException if absent
    if (!real.startsWith(realBase) || !Files.isRegularFile(real)) {
        throw new SecurityException("Path escapes base directory");
    }
    return real;
}

@GetMapping("/download")
public ResponseEntity<Resource> download(@RequestParam String filename) throws IOException {
    Path file = resolveExistingFile(parseFileName(filename), Path.of("/var/app/uploads"));
    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_DISPOSITION, "attachment")
        .body(new FileSystemResource(file));
}
```

Notes:
- `Path.startsWith` compares whole path elements, so `/uploads-evil` does not start with `/uploads`. `String.startsWith` on paths does not have that property.
- A check followed by a later open can be raced if the attacker can write inside the base directory. Keep that directory writable only by the application, and do not log the rejected input verbatim.
- Do not serve the upload directory as a static resource location; serve files through a handler that authorizes the caller (see `file-upload-security.md`).

## Testing

Test the function with input that is traversal at the `Path` level, and test encodings through the HTTP layer, where decoding happens.

```java
@ParameterizedTest
@ValueSource(strings = {"../etc/passwd", "a/../../etc/passwd", "/etc/passwd"})
void rejectsEscapingPaths(String payload) {
    assertThrows(SecurityException.class,
        () -> resolveSafePath(payload, Path.of("/var/app/uploads")));
}

@ParameterizedTest
@ValueSource(strings = {"../etc/passwd", "..\\win.ini", "%2e%2e%2fetc%2fpasswd", ".hidden", "-rf", "a/b"})
void rejectsUnsafeNames(String payload) {
    assertThrows(BadRequestException.class, () -> parseFileName(payload));
}

@Test
void downloadRejectsTraversal() throws Exception {
    mockMvc.perform(get("/download").param("filename", "../../etc/passwd"))
        .andExpect(status().isBadRequest());
}
```

On POSIX `..\windows\...` and `%2e%2e%2f...` are ordinary file names to `Path`, so `resolveSafePath` alone accepts them; the name parser is what rejects them. Encoded separators in the URL path itself are refused by Spring Security's `StrictHttpFirewall` before the controller runs.

## Quick Reference

| Do | Don't |
|----|-------|
| Look files up by an id you issued | Build a path from request text |
| Parse names against a strict pattern and reject | Strip `../` and continue |
| `resolve().normalize()` + `Path.startsWith(base)` | `String.startsWith`, or no check |
| `toRealPath()` and re-check for existing files | Trust `normalize()` against symlinks |
| Serve through an authorizing handler | Map the upload directory as static content |
