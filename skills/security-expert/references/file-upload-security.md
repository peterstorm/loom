# File Upload Security Reference

## Attack Vectors

| Attack | How |
|--------|-----|
| Malicious file execution | `.jsp`, `.php`, `.sh` stored where the server will execute it |
| Path traversal via filename | `filename="../../webapps/ROOT/shell.jsp"` |
| Content-type spoofing | The request says `image/png`; the bytes are something else |
| Active content | SVG and HTML run script when opened from your origin |
| Polyglot | A valid image that is also valid script or HTML |
| Decompression bomb | A small archive that expands to gigabytes, or to millions of entries |

## Rules

1. The client's filename and `Content-Type` are attacker-controlled. Use neither to decide the type or the stored name.
2. Detect the type from the content and allowlist it. The stored extension comes from the detected type.
3. Generate the stored name (UUID). Keep the original name only as data, for display.
4. Store outside the web root, with owner-only permissions, never under a static resource location.
5. Serve through a handler that authorizes the caller, as an attachment, ideally from a separate origin.
6. Limit size per file, per request, and per extracted archive.

## Upload Handler

```java
@RestController
public class FileUploadController {

    private static final long MAX_FILE_SIZE = 10 * 1024 * 1024;
    private static final Path UPLOAD_DIR = Path.of("/var/app/uploads");        // outside the web root
    private static final Map<String, String> EXTENSION_BY_TYPE = Map.of(
        "application/pdf", ".pdf",
        "image/png", ".png",
        "image/jpeg", ".jpg");

    private final Tika tika = new Tika();                                      // Apache Tika: detects from content

    @PostMapping("/upload")
    public UploadResponse upload(@RequestParam MultipartFile file) throws IOException {
        if (file.isEmpty() || file.getSize() > MAX_FILE_SIZE) {
            throw new BadRequestException("Invalid file size");
        }
        String detected;
        try (InputStream in = file.getInputStream()) {
            detected = tika.detect(in);                                        // magic bytes, not the request header
        }
        String extension = EXTENSION_BY_TYPE.get(detected);
        if (extension == null) {
            throw new BadRequestException("File type not allowed");
        }

        String storedName = UUID.randomUUID() + extension;                     // never the original filename
        Path target = UPLOAD_DIR.resolve(storedName);
        try (InputStream in = file.getInputStream()) {
            Files.copy(in, target);                                            // fails if the name exists
        }
        Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-------"));
        return new UploadResponse(storedName);
    }
}
```

What detection does not give you:
- **Text formats** (CSV, JSON, plain text) have no signature. Accept them only by parsing them with a strict parser and rejecting what does not parse.
- **Containers** (`.xlsx`, `.docx` are zip archives) need the archive limits below and an XML parser configured per `xxe-prevention.md`.
- **SVG** is XML with script. Do not accept it as an image; if you must, rasterise it or serve it only as an attachment from a separate origin.
- **A matching signature is not a clean file.** Re-encode images (decode and write a new PNG/JPEG) to drop polyglot payloads and metadata, and scan with an antivirus engine (ClamAV, or your cloud provider's scanner) before the file becomes downloadable.

## Serving Uploaded Files

```java
private static final Pattern STORED_NAME =
    Pattern.compile("^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.(pdf|png|jpg)$");

@GetMapping("/files/{name}")
public ResponseEntity<Resource> download(@PathVariable String name, Authentication auth) {
    if (!STORED_NAME.matcher(name).matches()) {
        throw new BadRequestException("Invalid file name");
    }
    if (!uploads.isReadableBy(name, auth.getName())) {            // object-level authorization
        throw new AccessDeniedException("Not authorized");
    }
    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + name + "\"")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .contentType(MediaType.APPLICATION_OCTET_STREAM)
        .body(new FileSystemResource(UPLOAD_DIR.resolve(name)));
}
```

The name pattern admits no separator, so no containment check is needed here; for any looser input use `resolveExistingFile` from `path-traversal.md`. Serving user content from a separate origin (for example `usercontent.example.net`) keeps a file that does render from reading your application's cookies and DOM.

## Archive Extraction

A zip entry's declared size is written by whoever made the archive, and with `ZipInputStream` it is often `-1`. Count the bytes you write.

```java
/** Extract into an empty directory created for this archive; delete it if this throws. */
public static void extractZip(Path zipFile, Path targetDir, long maxTotalBytes, int maxEntries)
        throws IOException {
    Path base = targetDir.toRealPath();
    long total = 0;
    int entries = 0;
    byte[] buffer = new byte[8192];

    try (ZipInputStream zis = new ZipInputStream(Files.newInputStream(zipFile))) {
        for (ZipEntry entry; (entry = zis.getNextEntry()) != null; ) {
            if (++entries > maxEntries) {
                throw new IOException("Too many zip entries");
            }
            Path out = base.resolve(entry.getName()).normalize();              // zip slip check
            if (!out.startsWith(base)) {
                throw new IOException("Zip entry escapes target directory");
            }
            if (entry.isDirectory()) {
                Files.createDirectories(out);
                continue;
            }
            Files.createDirectories(out.getParent());
            try (OutputStream os = Files.newOutputStream(out, StandardOpenOption.CREATE_NEW)) {
                for (int n; (n = zis.read(buffer)) != -1; ) {
                    total += n;                                                // bytes actually produced
                    if (total > maxTotalBytes) {
                        throw new IOException("Zip exceeds size limit");
                    }
                    os.write(buffer, 0, n);
                }
            }
        }
    }
}
```

Do not extract nested archives recursively without applying the same budget to the whole tree.

## Spring Boot Configuration
```yaml
spring:
  servlet:
    multipart:
      max-file-size: 10MB
      max-request-size: 10MB
      file-size-threshold: 2KB   # write to disk above this
      location: /var/app/upload-tmp
```

## Quick Reference

| Layer | Check |
|-------|-------|
| Type | Detected from content, allowlisted; client `Content-Type` and extension ignored |
| Filename | Generated UUID plus the extension of the detected type |
| Storage | Outside web root, owner-only permissions, not a static location |
| Content | Re-encode images, antivirus scan, no SVG/HTML as inline content |
| Serving | Authorized handler, `Content-Disposition: attachment`, `nosniff`, separate origin |
| Size | Per file, per request, and bytes actually extracted |
| Archives | Entry count limit, byte budget while copying, zip-slip check |
