# Command Injection Prevention Reference

## The Attack

User input reaches an OS command. There are two distinct problems:

- **Shell injection.** The command line is handed to a shell (`sh -c`, `cmd /c`), which interprets `;`, `|`, `&&`, `$(...)` and backticks.
- **Argument (option) injection.** No shell is involved, but the input becomes one or more arguments of the program, and an argument starting with `-` is read as an option.

```
sh -c "ping -c 1 $host"      host = 8.8.8.8; cat /etc/passwd     → second command runs
tar cf out.tar <name>        name = --checkpoint-action=exec=sh  → tar runs a program
curl <url>                   url  = -o/var/www/shell.jsp         → writes a file
```

## Vulnerable Patterns

### Invoking a shell
```java
// VULNERABLE: the shell parses the whole string
String host = request.getParameter("host");
new ProcessBuilder("sh", "-c", "ping -c 1 " + host).start();
```

### Runtime.exec(String)
```java
// VULNERABLE to argument injection, not to shell metacharacters.
// exec(String) starts no shell; it splits the string on whitespace.
String filename = request.getParameter("file");
Runtime.getRuntime().exec("convert " + filename + " output.pdf");
// "a.png -write /var/www/x.jsp" → two extra arguments for convert
```

### Arguments passed to a script
```java
// VULNERABLE if the script uses $1 unquoted or passes it to eval
new ProcessBuilder("bash", "/opt/scripts/process.sh", param).start();
```

## Prevention

### 1. Do not run a command
Use a library: `java.util.zip` instead of `zip`, PDFBox instead of a PDF tool, an image library instead of `convert`.

A network probe is not a safe substitute: resolving or connecting to a user-supplied host (`InetAddress.getByName(host)`, `isReachable`) is server-side request forgery. See `ssrf.md`.

### 2. If a command is necessary
- Pass an argument array; never a shell and never one concatenated string.
- Give the program a path the server built (for example the UUID name from `file-upload-security.md`), not text the user typed.
- When user text must be an argument, parse it against an allowlist that rejects a leading `-`, and put `--` before it when the program supports end-of-options.
- Use an absolute path for the executable, an empty environment, a working directory, and a timeout.

```java
private static final Pattern SAFE_NAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$");

/** Parse, do not sanitise: return the input unchanged or reject it. */
static String parseFileName(String input) {
    if (input == null || !SAFE_NAME.matcher(input).matches()) {   // first character is never '-' or '.'
        throw new BadRequestException("Invalid file name");
    }
    return input;
}

// uploadDir and outputDir are absolute, so neither argument can start with '-'
List<String> argv = List.of("/usr/bin/convert",
    uploadDir.resolve(parseFileName(userInput)).toString(),
    outputDir.resolve(UUID.randomUUID() + ".pdf").toString());

// A bare user value as an argument: end-of-options first, where the program supports it
List<String> grep = List.of("/usr/bin/grep", "-F", "--", parseFileName(needle), logFile.toString());
```

Some tools interpret arguments beyond options (ImageMagick reads `label:`, `msl:` and `@file` prefixes; `git` and `ssh` accept options that run programs). An allowlist without `:` and `@`, plus an absolute path, closes those. Check the tool's manual for what it does with its arguments before passing it anything user-derived.

### 3. Process wrapper
```java
public final class SafeCommand {

    private static final long MAX_OUTPUT_BYTES = 1 << 20;

    /** argv.get(0) is an absolute path. Output goes to a file, so a chatty process cannot block on a full pipe. */
    public static String run(List<String> argv, Path workDir, Duration timeout)
            throws IOException, InterruptedException, TimeoutException {
        Path out = Files.createTempFile("cmd-", ".out");
        try {
            ProcessBuilder pb = new ProcessBuilder(argv)
                .directory(workDir.toFile())
                .redirectErrorStream(true)
                .redirectOutput(out.toFile());
            pb.environment().clear();                    // nothing inherited

            Process process = pb.start();
            if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                throw new TimeoutException("Command timed out");
            }
            if (process.exitValue() != 0) {
                throw new IOException("Command failed: exit " + process.exitValue());
            }
            if (Files.size(out) > MAX_OUTPUT_BYTES) {
                throw new IOException("Command output too large");
            }
            return Files.readString(out);
        } finally {
            Files.deleteIfExists(out);
        }
    }
}
```

Reading `getInputStream()` only after `waitFor` deadlocks once the process fills the pipe buffer; redirect to a file (as above) or drain the stream on another thread.

## Quick Reference

| Do | Don't |
|----|-------|
| Use a Java library | Shell out for something a library does |
| `new ProcessBuilder(List.of(exe, "--", arg))` | `sh -c`, `Runtime.exec("cmd " + input)` |
| Parse input with an allowlist; reject a leading `-` | Strip or escape "bad" characters |
| Server-built absolute paths as arguments | User-typed names as arguments |
| Absolute executable, empty environment, timeout | Inherited `PATH` and environment, no timeout |
| Redirect output to a file or drain it concurrently | Read stdout after `waitFor` |
