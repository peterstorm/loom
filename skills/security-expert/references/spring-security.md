# Spring Security Reference

Samples use the lambda DSL, which is valid on Spring Security 6.x (Boot 3) and 7 (Boot 4). Where an API differs by version, the sample says so. Topics owned elsewhere: token validation `jwt-security.md`, CSRF `csrf-prevention.md`, headers and CORS `security-headers.md`, `PermissionEvaluator` and policies `authorization-patterns.md`, OAuth client flows `oauth-oidc.md`.

## Architecture

```
Request → DelegatingFilterProxy → FilterChainProxy → SecurityFilterChain → Controller
                                        ↓
                              [SecurityContextHolder]
                                        ↓
                               Authentication object
```

- **SecurityContextHolder**: holds the `Authentication` for the current request
- **Authentication**: principal, credentials, authorities
- **AuthenticationManager**: validates credentials
- **AuthorizationManager**: decides access

## Filter Chain

### Typical filter order (resource server, Spring Security 6.x)
```
1. DisableEncodeUrlFilter
2. WebAsyncManagerIntegrationFilter
3. SecurityContextHolderFilter
4. HeaderWriterFilter
5. CorsFilter
6. CsrfFilter
7. LogoutFilter
8. OAuth2AuthorizationRequestRedirectFilter
9. OAuth2LoginAuthenticationFilter
10. BearerTokenAuthenticationFilter      ← JWT validation
11. RequestCacheAwareFilter
12. SecurityContextHolderAwareRequestFilter
13. AnonymousAuthenticationFilter
14. ExceptionTranslationFilter
15. AuthorizationFilter                   ← Access decisions
```
The exact list depends on what is configured; `logging.level.org.springframework.security=DEBUG` prints the chain of your application at startup.

### Custom filter
```java
public class ApiKeyAuthFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String apiKey = request.getHeader("X-API-Key");
        if (apiKey != null) {
            apiKeys.authenticate(apiKey)                         // looks up a hash of the key; empty if unknown
                .ifPresent(auth -> SecurityContextHolder.getContext().setAuthentication(auth));
        }
        chain.doFilter(request, response);                       // unauthenticated requests are refused by the rules below
    }
}

http.addFilterBefore(apiKeyFilter, BearerTokenAuthenticationFilter.class);
```
Store API keys hashed and compare in constant time (`MessageDigest.isEqual`). Do not also register the filter as a `@Component`, or Boot adds it to the servlet chain a second time, outside Spring Security.

## OAuth2 Resource Server

```java
@Configuration
@EnableWebSecurity
public class ResourceServerConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http, JwtDecoder jwtDecoder) throws Exception {
        http
            // Only because this API authenticates solely by the Authorization header.
            // If any credential (session or token) is ever sent by cookie, keep CSRF on: csrf-prevention.md
            .csrf(csrf -> csrf.disable())
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .oauth2ResourceServer(oauth2 -> oauth2
                .jwt(jwt -> jwt
                    .decoder(jwtDecoder)                         // algorithms, issuer, audience: jwt-security.md
                    .jwtAuthenticationConverter(jwtAuthConverter())))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/health").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .requestMatchers("/api/**").authenticated()
                .anyRequest().denyAll());                        // deny by default

        return http.build();
    }

    @Bean
    public JwtAuthenticationConverter jwtAuthConverter() {
        JwtGrantedAuthoritiesConverter authorities = new JwtGrantedAuthoritiesConverter();
        authorities.setAuthoritiesClaimName("roles");
        authorities.setAuthorityPrefix("ROLE_");

        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(authorities);
        converter.setPrincipalClaimName("sub");
        return converter;
    }
}
```

The `JwtDecoder` bean must validate the audience as well as the issuer; the Boot default built from `issuer-uri` alone does not check `aud` unless `spring.security.oauth2.resourceserver.jwt.audiences` is set. Keycloak's nested roles need the converter in `keycloak.md`.

### Opaque tokens (introspection)
```java
http.oauth2ResourceServer(oauth2 -> oauth2
    .opaqueToken(opaque -> opaque
        .introspectionUri("https://auth.example.com/realms/app/protocol/openid-connect/token/introspect")
        .introspectionClientCredentials(clientId, clientSecret)));     // from configuration, not literals
```

### Browser-facing chains
A chain that authenticates with a session or any cookie keeps CSRF protection enabled (`csrf-prevention.md`), sets headers and CORS per `security-headers.md`, and logs users in per `oauth-oidc.md`. Give the cookie-authenticated routes and the bearer-token routes separate `SecurityFilterChain` beans with `securityMatcher(...)` rather than one chain with CSRF disabled for both.

## Method Security

```java
@Configuration
@EnableMethodSecurity            // @PreAuthorize/@PostAuthorize on; add securedEnabled = true for @Secured
public class MethodSecurityConfig { }
```

```java
@Service
public class DocumentService {

    @PreAuthorize("hasRole('ADMIN')")
    public void deleteAll() { }

    @PreAuthorize("hasAnyRole('ADMIN', 'MANAGER')")
    public List<Document> listAll() { }

    // Parameter-based expression
    @PreAuthorize("#document.ownerId == authentication.name or hasRole('ADMIN')")
    public void update(Document document) { }

    // Check the returned object; the method body has already run, so use only on reads
    @PostAuthorize("returnObject.ownerId == authentication.name")
    public Document findById(String id) { }

    // Filters in memory after loading everything; prefer a query scoped to the caller
    @PostFilter("filterObject.ownerId == authentication.name or hasRole('ADMIN')")
    public List<Document> findAll() { }

    // Delegates to a PermissionEvaluator: authorization-patterns.md
    @PreAuthorize("hasPermission(#id, 'Document', 'read')")
    public Document read(String id) { }
}
```

Method security is proxy-based: a call from another method of the same bean bypasses it, and so does a `private` method.

## Error Handling

```java
http.exceptionHandling(exceptions -> exceptions
    .authenticationEntryPoint((request, response, authException) -> {
        response.setStatus(HttpStatus.UNAUTHORIZED.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("""
            {"error": "unauthorized", "message": "Authentication required"}
            """);
    })
    .accessDeniedHandler((request, response, accessDeniedException) -> {
        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("""
            {"error": "forbidden", "message": "Insufficient permissions"}
            """);
    }));
```
Return fixed messages. Exception text can reveal which check failed or whether an account exists.

## Testing Security

```java
@SpringBootTest
@AutoConfigureMockMvc
class SecurityTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void unauthenticatedRequest_returns401() throws Exception {
        mockMvc.perform(get("/api/protected"))
            .andExpect(status().isUnauthorized());
    }

    @Test
    @WithMockUser(roles = "USER")
    void regularUser_cannotAccessAdmin() throws Exception {
        mockMvc.perform(get("/api/admin"))
            .andExpect(status().isForbidden());
    }

    @Test
    void unmappedRoute_isDenied() throws Exception {
        mockMvc.perform(get("/not-listed").with(jwt()))
            .andExpect(status().isForbidden());
    }

    @Test
    void withJwt_canAccess() throws Exception {
        mockMvc.perform(get("/api/protected")
            .with(jwt()
                .jwt(jwt -> jwt.subject("user-123"))
                .authorities(new SimpleGrantedAuthority("ROLE_USER"))))
            .andExpect(status().isOk());
    }
}
```

`jwt()` and `@WithMockUser` put an `Authentication` in place without running the decoder, so they test authorization rules, not token validation. Test the `JwtDecoder` separately with tokens signed by a test key: wrong audience, wrong issuer, expired, wrong algorithm.
