# Authorization Patterns Reference

## Rules That Apply to Every Model

1. **Deny by default.** The last line of every policy is a deny. An unknown action, resource type or missing attribute is a deny.
2. **Deny rules are evaluated first** and win over any permit.
3. **Every permit names the action** it allows. "Has clearance" or "is in the department" without an action permits delete as well as read.
4. **Check the object, not only the route.** A role check on `/documents/**` does not stop user A reading user B's document (see `owasp-api-security.md`, API1).
5. **Fail closed.** If the policy engine errors or times out, the answer is deny.

## Choosing a Model

| Model | Decision is a function of | Use when |
|-------|---------------------------|----------|
| RBAC | The user's roles | Stable job functions, coarse permissions, audit requirements |
| ABAC | Subject, resource, action and environment attributes | Ownership, department, classification, time or location matter |
| ReBAC | Relationships between objects (Zanzibar, SpiceDB) | Sharing, nested folders, teams, organisation hierarchies |

They combine: RBAC at the route, ABAC or ReBAC at the object.

## RBAC

Users have roles; roles map to permissions; code checks the permission (`READ_DOCUMENT`), not the role name, so roles can be regrouped without touching call sites. A role with no mapping has no permissions.

### Role hierarchy (Spring Security 6.3+)
```java
@Bean
static RoleHierarchy roleHierarchy() {
    return RoleHierarchyImpl.withDefaultRolePrefix()
        .role("ADMIN").implies("MANAGER")
        .role("MANAGER").implies("USER")
        .build();
}
```
`RoleHierarchyImpl.fromHierarchy("ROLE_ADMIN > ROLE_MANAGER\nROLE_MANAGER > ROLE_USER")` is the string form; `new RoleHierarchyImpl()` with `setHierarchy` is the deprecated one. With `@PreAuthorize`, also pass the hierarchy to the `DefaultMethodSecurityExpressionHandler` (`setRoleHierarchy`).

## ABAC

The decision is a pure function: attributes in, decision out. The clock is an input, which makes the time rule testable.

```java
public enum Decision { PERMIT, DENY }
public record Subject(String id, String department, int clearance) {}
public record Document(String ownerId, String department, int classification, boolean confidential) {}
public record AccessRequest(Subject subject, Document document, String action, LocalTime now) {}

public final class DocumentPolicy {
    private static final LocalTime OPEN = LocalTime.of(9, 0);
    private static final LocalTime CLOSE = LocalTime.of(18, 0);

    public static Decision evaluate(AccessRequest r) {
        boolean businessHours = !r.now().isBefore(OPEN) && r.now().isBefore(CLOSE);

        // 1. Deny rules first: they win over every permit below.
        if (r.document().confidential() && !businessHours) return Decision.DENY;
        if (r.subject().clearance() < r.document().classification()) return Decision.DENY;

        // 2. Permits, each tied to an action.
        boolean owner = r.document().ownerId().equals(r.subject().id());
        boolean sameDepartment = r.document().department().equals(r.subject().department());
        boolean permitted = switch (r.action()) {
            case "read" -> owner || sameDepartment;
            case "write", "delete" -> owner;
            default -> false;                                   // unknown action
        };

        // 3. Default deny.
        return permitted ? Decision.PERMIT : Decision.DENY;
    }
}
```

Clearance is a precondition here, not a permit: having clearance does not by itself allow anything.

### Spring Security integration: `PermissionEvaluator`

```java
@Component
public class DocumentPermissionEvaluator implements PermissionEvaluator {

    private final DocumentRepository documents;
    private final Clock clock;

    public DocumentPermissionEvaluator(DocumentRepository documents, Clock clock) {
        this.documents = documents;
        this.clock = clock;
    }

    @Override
    public boolean hasPermission(Authentication auth, Object target, Object permission) {
        if (!(target instanceof Document document) || !(permission instanceof String action)) {
            return false;                                       // unknown type: deny
        }
        AccessRequest request = new AccessRequest(subjectOf(auth), document, action, LocalTime.now(clock));
        return DocumentPolicy.evaluate(request) == Decision.PERMIT;
    }

    @Override
    public boolean hasPermission(Authentication auth, Serializable id, String type, Object permission) {
        if (!"Document".equals(type)) return false;
        return documents.findById(id.toString())
            .map(document -> hasPermission(auth, document, permission))
            .orElse(false);                                     // missing object: deny
    }

    private Subject subjectOf(Authentication auth) { /* read claims from the validated token */ }
}

@Bean
static MethodSecurityExpressionHandler methodSecurityExpressionHandler(DocumentPermissionEvaluator evaluator) {
    DefaultMethodSecurityExpressionHandler handler = new DefaultMethodSecurityExpressionHandler();
    handler.setPermissionEvaluator(evaluator);
    return handler;
}

@PreAuthorize("hasPermission(#id, 'Document', 'write')")
public void update(String id, DocumentUpdate update) { }
```

Subject attributes must come from a source the user cannot edit. A department or clearance claim copied from a self-service profile field is a privilege-escalation path (see `keycloak.md`, user attributes).

## ReBAC (SpiceDB)

Schema, relationships and the check, in SpiceDB's notation. A relationship reads `resource#relation@subject`.

```
definition user {}

definition team {
    relation member: user
}

definition folder {
    relation viewer: user | team#member
    permission read = viewer
}

definition document {
    relation owner: user
    relation viewer: user | team#member
    relation parent: folder

    permission read = viewer + owner + parent->read
    permission write = owner
}
```

```
document:report#owner@user:alice
document:report#viewer@team:engineering#member
document:report#parent@folder:projects
team:engineering#member@user:bob
```

```java
// authzed-java: generated gRPC stubs plus a bearer-token credential
ManagedChannel channel = ManagedChannelBuilder.forTarget("spicedb.internal:50051")
    .useTransportSecurity().build();
PermissionsServiceGrpc.PermissionsServiceBlockingStub permissions =
    PermissionsServiceGrpc.newBlockingStub(channel).withCallCredentials(new BearerToken(presharedKey));

CheckPermissionResponse response = permissions.checkPermission(CheckPermissionRequest.newBuilder()
    .setConsistency(Consistency.newBuilder().setFullyConsistent(true))
    .setResource(ObjectReference.newBuilder().setObjectType("document").setObjectId("report"))
    .setPermission("read")
    .setSubject(SubjectReference.newBuilder()
        .setObject(ObjectReference.newBuilder().setObjectType("user").setObjectId("bob")))
    .build());

boolean allowed = response.getPermissionship()
    == CheckPermissionResponse.Permissionship.PERMISSIONSHIP_HAS_PERMISSION;   // anything else is deny
```

A check that reads stale data can allow access that was just revoked. Use full consistency, or pass the token returned by the write, for checks that follow a permission change.

## Policy Engines

### Open Policy Agent (Rego v1)
OPA 1.0 requires `if` before a rule body and `:=` for assignment.

```rego
package authz

default allow := false

allow if {
    not denied
    permitted
}

denied if {
    input.resource.confidential
    not business_hours
}

permitted if "admin" in input.user.roles

permitted if {
    input.action == "read"
    input.user.department == input.resource.department
}

business_hours if {
    [hour, _, _] := time.clock([time.now_ns(), "Europe/Copenhagen"])
    hour >= 9
    hour < 18
}
```

Business hours restricts; it is never a permit of its own. The caller treats only a literal `true` from `/v1/data/authz/allow` as allow: a missing result, an error or a timeout is deny.

### Casbin
`r.obj == p.obj` compares strings, so a policy path with a wildcard never matches. Use a path-matching function.

```ini
[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub) && keyMatch2(r.obj, p.obj) && (r.act == p.act || p.act == "*")
```

```csv
p, admin, /api/*, *
p, user, /api/documents/:id, read
p, editor, /api/documents/:id, write
g, alice, admin
g, bob, editor
```

`some(where (p.eft == allow))` is deny by default: a request no policy line matches is refused.

## Testing

For each policy, assert the denials as carefully as the permits: another user's object, an unknown action, a missing attribute, a deny rule combined with a matching permit, and the engine being unavailable.
