# SSRF Prevention Reference

## The Attack

The server fetches a URL the caller influences, and the request lands on something only the server can reach: an internal service, a loopback admin port, or the cloud metadata endpoint (`169.254.169.254`).

```json
POST /api/import
{"url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"}
```

Sources of such URLs: import-from-URL and webhook features, image and PDF renderers, link previews, XML external entities (`xxe-prevention.md`), and URLs inside third-party API responses.

## Vulnerable Pattern

```java
// VULNERABLE: check one resolution, connect with another
InetAddress address = InetAddress.getByName(url.getHost());
if (address.isLoopbackAddress() || address.isSiteLocalAddress()) throw new BadRequestException("Internal");
return httpClient.fetch(url);
```
- The HTTP client resolves the name again; the attacker's DNS answers differently the second time (DNS rebinding).
- `isSiteLocalAddress()` misses `0.0.0.0`, IPv6 unique-local addresses and carrier-grade NAT space.
- A redirect from an allowed host leads anywhere.

## Prevention

1. **Allowlist the destination host.** This is the primary control; address filtering is the second layer.
2. **HTTPS only**, no credentials in the URL, **redirects not followed**.
3. **The address that is checked is the address that is dialled**: filter inside the client's DNS resolver, or connect to the resolved address yourself.
4. **Refuse non-public addresses**: loopback, private, link-local, unique-local, carrier-grade NAT, unspecified, multicast.
5. Bound response size and time, and do not relay the raw response or error to the caller.

```java
// Apache HttpClient 5. The resolver runs when a connection is opened, so check and connect use the same addresses.
public final class OutboundFetcher {

    private static final Set<String> ALLOWED_HOSTS = Set.of("api.trusted-partner.com", "cdn.example.com");
    private static final int MAX_BYTES = 5 * 1024 * 1024;

    private static final DnsResolver PUBLIC_ONLY = new DnsResolver() {
        @Override
        public InetAddress[] resolve(String host) throws UnknownHostException {
            InetAddress[] addresses = InetAddress.getAllByName(host);
            for (InetAddress address : addresses) {
                if (!isPublic(address)) throw new UnknownHostException("Blocked address for " + host);
            }
            return addresses;
        }

        @Override
        public String resolveCanonicalHostname(String host) {
            return host;
        }
    };

    private final CloseableHttpClient client = HttpClients.custom()
        .setConnectionManager(PoolingHttpClientConnectionManagerBuilder.create()
            .setDnsResolver(PUBLIC_ONLY)
            .build())
        .disableRedirectHandling()
        .build();

    public byte[] fetch(String url) throws IOException {
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            throw new BadRequestException("Invalid URL");
        }
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || uri.getUserInfo() != null
                || uri.getHost() == null
                || !ALLOWED_HOSTS.contains(uri.getHost().toLowerCase(Locale.ROOT))) {
            throw new BadRequestException("URL not allowed");
        }
        return client.execute(new HttpGet(uri), response -> {
            if (response.getCode() != 200) {                       // a 3xx is an error: redirects are not followed
                throw new IOException("Unexpected status " + response.getCode());
            }
            return EntityUtils.toByteArray(response.getEntity(), MAX_BYTES);   // bounded read
        });
    }

    static boolean isPublic(InetAddress a) {
        // 0.0.0.0 and ::, 127/8 and ::1, 169.254/16 and fe80::/10, 10/8, 172.16/12, 192.168/16, multicast
        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress()
                || a.isSiteLocalAddress() || a.isMulticastAddress()) {
            return false;
        }
        byte[] b = a.getAddress();
        if (b.length == 4) {
            int b0 = b[0] & 0xff;
            int b1 = b[1] & 0xff;
            boolean blocked = b0 == 0                              // 0.0.0.0/8
                || (b0 == 100 && (b1 & 0xc0) == 64)                // 100.64.0.0/10 carrier-grade NAT
                || (b0 == 198 && (b1 & 0xfe) == 18)                // 198.18.0.0/15
                || b0 >= 240;                                      // reserved and broadcast
            return !blocked;
        }
        return (b[0] & 0xfe) != 0xfc;                              // fc00::/7 unique local
    }
}
```

Notes:
- Java turns IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`) into `Inet4Address`, so the IPv4 rules cover them. In another language, unwrap the mapped form explicitly.
- If your network routes NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`), block those prefixes too.
- Behind an outbound HTTP proxy the proxy resolves the name, so the address filter has to live in the proxy.
- With `java.net.http.HttpClient` there is no resolver hook: keep the allowlist and `followRedirects(NEVER)`, and enforce the address rules at the network layer (egress proxy or firewall).

### When callers may name any host (webhooks)
There is no allowlist, so the address filter becomes the main control. Add: verify the caller owns the URL (challenge request), allow only ports 443 and 80, send the request from an isolated network segment with no route to internal services or the metadata endpoint, and require the instance metadata service to use session tokens (IMDSv2 on AWS).

## Testing

Unit-test `isPublic` with one address from every blocked range and the mapped form. Test `fetch` against a local server for: a host outside the allowlist, `http://`, a URL with user info, and a 302 response (must fail, not follow).

## Quick Reference

| Do | Don't |
|----|-------|
| Allowlist destination hosts | Denylist "internal-looking" names |
| Filter addresses in the resolver the client connects with | Resolve, check, then let the client resolve again |
| Block private, loopback, link-local, ULA, CGNAT, unspecified | Rely on `isSiteLocalAddress()` alone |
| Disable redirects | Follow a redirect from an allowed host |
| Egress controls at the network layer as well | Trust application checks alone |
