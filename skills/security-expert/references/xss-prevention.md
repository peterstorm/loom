# XSS Prevention Reference (React/TypeScript)

## The Attack

Attacker-controlled data is interpreted as markup or script in a victim's browser.

- **Stored**: the payload is saved and rendered to other users.
- **Reflected**: the payload comes from the request (URL, form) and is echoed in the response.
- **DOM-based**: client-side code moves untrusted data into a dangerous sink.

```typescript
// VULNERABLE: DOM sink fed from the URL
document.getElementById('content')!.innerHTML = location.hash.slice(1);
```

## What React Does and Does Not Do

React escapes strings rendered as children and as ordinary attribute values, so markup in data is displayed as text.

```tsx
// SAFE: text content and plain attributes are escaped
<div title={user.bio}>Hello, {user.name}</div>
<ul>{comments.map((c) => <li key={c.id}>{c.text}</li>)}</ul>
```

Escaping is not enough for these sinks:

| Sink | Why | What to do |
|------|-----|------------|
| `dangerouslySetInnerHTML` | Raw HTML, no escaping | Sanitise first (below) |
| `href`, `src`, `action`, `formAction` | The value is a URL; escaping does not stop `javascript:` or `data:` | Parse and allowlist the scheme (below) |
| `ref.current.innerHTML = ...`, `document.write`, `insertAdjacentHTML` | Bypass React | Render through JSX instead |
| `eval`, `new Function`, string arguments to `setTimeout`/`setInterval` | Code execution | Never with data |
| `<script>` built from data, JSON inlined into a script block | `</script>` in the data closes the block | Use the framework's data passing; escape `<` as `<` if you must inline |
| `style` from data, CSS injected as text | Data exfiltration, UI redress | Fixed class names; never user CSS |

## URLs

React 19 refuses to render `javascript:` URLs in `href` and `src`; earlier versions only warn. Validate anyway: the check also covers older React, `data:` URLs and sinks React does not see (`window.location = url`, `window.open(url)`).

```typescript
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Parse, do not validate: returns the normalised URL or null. */
export function parseSafeUrl(input: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(input, base);          // the URL parser strips the whitespace and control characters used to hide "javascript:"
  } catch {
    return null;
  }
  return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
}
```

```tsx
function UserLink({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = parseSafeUrl(href, 'https://app.example.com');
  return safe ? <a href={safe} rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
}
```

Render the returned value, not the original string, so what was checked is what is used. For images and iframes additionally allowlist the host. Sending the user to an arbitrary external URL after login is an open redirect, a separate check: compare the origin with your own.

## Rendering HTML

When HTML from users or a CMS must be rendered, sanitise it with an allowlist.

DOMPurify needs a DOM. In the browser it uses the page's; on the server (Node, React Server Components, and the server render of Client Components) plain `dompurify` has none. Use `isomorphic-dompurify`, or `dompurify` with a current `jsdom` window, or sanitise once on the server when the content is saved.

```tsx
import DOMPurify from 'isomorphic-dompurify';

const CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre'],
  ALLOWED_ATTR: ['href', 'title'],
  ALLOW_DATA_ATTR: false,
};

export function RichText({ html }: { html: string }) {
  const clean = DOMPurify.sanitize(html, CONFIG);
  return <div dangerouslySetInnerHTML={{ __html: clean }} />;
}
```

- **Markdown**: the renderer's output is HTML and goes through the same sanitiser: `DOMPurify.sanitize(await marked.parse(markdown), CONFIG)`. Or render Markdown to React elements (`react-markdown`) without raw HTML enabled.
- Sanitise as the last step before the sink. Sanitising and then transforming the string (templating, concatenation, another parser) can reintroduce markup.
- Keep the sanitiser updated; bypasses are found and fixed regularly.

## Content Security Policy

A CSP limits the damage when an injection gets through: with a nonce-based `script-src`, injected inline script does not run. `security-headers.md` owns the policy, the Next.js nonce setup and reporting.

## Server-Rendered Views (Thymeleaf)

Thymeleaf escapes `th:text` and attribute values; `th:utext` is the raw sink and needs sanitised input (OWASP Java HTML Sanitizer or jsoup `Safelist`). JavaScript inlining (`th:inline="javascript"`) escapes for a script context; string concatenation into a script block does not.

## Testing

```tsx
import { render, screen } from '@testing-library/react';
import { RichText } from './RichText';
import { parseSafeUrl } from './url';

const BASE = 'https://app.example.com';

it('drops event handlers and scripts from rich text', () => {
  render(<RichText html={'<img src=x onerror=alert(1)><script>alert(1)</script><p>Safe</p>'} />);
  const html = screen.getByText('Safe').parentElement!.innerHTML;
  expect(html).not.toContain('onerror');
  expect(html).not.toContain('<script');
});

it.each(['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>'])(
  'rejects %s', (input) => {
    expect(parseSafeUrl(input, BASE)).toBeNull();
  });

it('accepts http(s) and resolves relative paths', () => {
  expect(parseSafeUrl('https://example.com/a', BASE)).toBe('https://example.com/a');
  expect(parseSafeUrl('/settings', BASE)).toBe('https://app.example.com/settings');
});
```

For end-to-end coverage, submit payloads through the UI in Playwright and assert no `dialog` event fires; run a DAST scan (OWASP ZAP baseline) against a deployed test environment.

## Quick Reference

| Do | Don't |
|----|-------|
| Render data through JSX | `innerHTML`, `document.write`, refs that set HTML |
| Sanitise HTML with an allowlist right before `dangerouslySetInnerHTML` | Render CMS or user HTML raw |
| Parse URLs and allowlist `http:`, `https:`, `mailto:` | Put user strings in `href`/`src` unchecked |
| A sanitiser that has a DOM on the server | Plain `dompurify` in server code |
| Nonce-based CSP as a second layer | Rely on CSP instead of fixing the sink |
| Never `eval` data | Build script or CSS from data |
