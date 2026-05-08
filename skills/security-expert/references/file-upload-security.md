# File Upload Security Reference

## Attack Vectors

### Malicious File Execution
Upload `.jsp`, `.php`, `.sh` to a web-accessible directory → remote code execution.

### Path Traversal via Filename
```
filename="../../webapps/ROOT/shell.jsp"
```

### Content Type Spoofing
File claims to be `image/png` but contains executable code.

### Zip Bomb / Decompression Bomb
Small compressed file expands to gigabytes → disk/memory exhaustion.

### Polyglot Files
Valid image that is also valid JavaScript/HTML — bypasses content-type checks.

## Prevention

### Complete Upload Handler
```java
@RestController
public class FileUploadController {

    private static final long MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    private static final Set<String> ALLOWED_EXTENSIONS = Set.of(
        ".pdf", ".png", ".jpg", ".jpeg", ".csv", ".xlsx"
    );
    private static final Set<String> ALLOWED_CONTENT_TYPES = Set.of(
        "application/pdf", "image/png", "image/jpeg", "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    @PostMapping("/upload")
    public UploadResponse upload(@RequestParam MultipartFile file) {
        validateFile(file);

        // Generate safe filename — NEVER use original
        String ext = getValidExtension(file.getOriginalFilename());
        String safeName = UUID.randomUUID() + ext;

        // Store outside web root
        Path target = Paths.get("/var/app/uploads").resolve(safeName);
        file.transferTo(target);

        // Set restrictive permissions
        Files.setPosixFilePermissions(target, Set.of(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE
        ));

        return new UploadResponse(safeName);
    }

    private void validateFile(MultipartFile file) {
        if (file.isEmpty()) throw new BadRequestException("Empty file");
        if (file.getSize() > MAX_FILE_SIZE) throw new BadRequestException("File too large");

        // Validate content type
        String contentType = file.getContentType();
        if (!ALLOWED_CONTENT_TYPES.contains(contentType)) {
            throw new BadRequestException("File type not allowed");
        }

        // Validate extension
        getValidExtension(file.getOriginalFilename());

        // Validate actual content (magic bytes)
        validateMagicBytes(file);
    }

    private String getValidExtension(String filename) {
        if (filename == null) throw new BadRequestException("No filename");
        int dot = filename.lastIndexOf('.');
        if (dot < 0) throw new BadRequestException("No extension");
        String ext = filename.substring(dot).toLowerCase();
        if (!ALLOWED_EXTENSIONS.contains(ext)) {
            throw new BadRequestException("Extension not allowed: " + ext);
        }
        return ext;
    }

    private void validateMagicBytes(MultipartFile file) {
        try {
            byte[] header = new byte[8];
            file.getInputStream().read(header);

            // Check magic bytes match claimed type
            String contentType = file.getContentType();
            if ("image/png".equals(contentType) && !isPng(header)) {
                throw new BadRequestException("File content doesn't match PNG");
            }
            if ("application/pdf".equals(contentType) && !isPdf(header)) {
                throw new BadRequestException("File content doesn't match PDF");
            }
        } catch (IOException e) {
            throw new BadRequestException("Cannot read file");
        }
    }

    private boolean isPng(byte[] header) {
        return header[0] == (byte) 0x89 && header[1] == 0x50
            && header[2] == 0x4E && header[3] == 0x47;
    }

    private boolean isPdf(byte[] header) {
        return header[0] == 0x25 && header[1] == 0x50
            && header[2] == 0x44 && header[3] == 0x46; // %PDF
    }
}
```

### Serving Uploaded Files Safely
```java
@GetMapping("/files/{filename}")
public ResponseEntity<Resource> download(@PathVariable String filename) {
    // Validate filename format (UUID + extension only)
    if (!filename.matches("^[a-f0-9-]+\\.[a-z]{3,4}$")) {
        throw new BadRequestException("Invalid filename");
    }

    Path file = Paths.get("/var/app/uploads").resolve(filename).normalize();
    if (!file.startsWith("/var/app/uploads")) {
        throw new SecurityException("Path traversal attempt");
    }

    Resource resource = new FileSystemResource(file);
    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'")
        .body(resource);
}
```

### Zip/Archive Upload Safety
```java
public void extractZipSafely(Path zipFile, Path targetDir, long maxTotalSize) {
    long totalSize = 0;
    int maxEntries = 1000;
    int entryCount = 0;

    try (ZipInputStream zis = new ZipInputStream(Files.newInputStream(zipFile))) {
        ZipEntry entry;
        while ((entry = zis.getNextEntry()) != null) {
            if (++entryCount > maxEntries) {
                throw new SecurityException("Too many zip entries");
            }

            // Path traversal check
            Path entryPath = targetDir.resolve(entry.getName()).normalize();
            if (!entryPath.startsWith(targetDir)) {
                throw new SecurityException("Zip path traversal: " + entry.getName());
            }

            // Size check (zip bomb protection)
            totalSize += entry.getSize();
            if (totalSize > maxTotalSize) {
                throw new SecurityException("Zip exceeds size limit");
            }

            // Extract
            if (entry.isDirectory()) {
                Files.createDirectories(entryPath);
            } else {
                Files.createDirectories(entryPath.getParent());
                Files.copy(zis, entryPath);
            }
        }
    }
}
```

### Spring Boot Configuration
```yaml
spring:
  servlet:
    multipart:
      max-file-size: 10MB
      max-request-size: 10MB
      file-size-threshold: 2KB  # Write to disk above this
      location: /tmp/uploads    # Temp storage location
```

## Quick Reference

| Layer | Check |
|-------|-------|
| Extension | Allowlist valid extensions |
| Content-Type | Allowlist MIME types |
| Magic bytes | Verify file header matches claimed type |
| Filename | Generate UUID, never use original |
| Storage | Outside web root, restrictive permissions |
| Serving | `Content-Disposition: attachment`, `nosniff`, no inline execution |
| Size | Enforce limits on individual file and request |
| Archives | Entry count limit, total size limit, path traversal check |
