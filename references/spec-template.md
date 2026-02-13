# Specification Template

Copy and populate this template for new specifications.

---

```markdown
# Feature: {Feature Name}

**Spec ID:** {YYYY-MM-DD}-{slug}
**Created:** {DATE}
**Status:** Draft | In Review | Approved
**Owner:** {who requested}

## Summary

{2-3 sentences: what problem does this solve and for whom}

---

## User Scenarios

### US1: [P1] {Scenario Title}

**As a** {user type}
**I want to** {action}
**So that** {benefit}

**Why this priority:** {justification for P1/P2/P3}

**Acceptance Scenarios:**
- Given {precondition}, When {action}, Then {expected result}
- Given {edge case}, When {action}, Then {error handling}

### US2: [P2] {Scenario Title}

**As a** {user type}
**I want to** {action}
**So that** {benefit}

**Why this priority:** {justification}

**Acceptance Scenarios:**
- Given {precondition}, When {action}, Then {expected result}

### US3: [P3] {Scenario Title}
...

---

## Functional Requirements

### Core Requirements

- FR-001: System MUST {requirement}
- FR-002: System MUST {requirement}
- FR-003: System SHOULD {requirement} [NEEDS CLARIFICATION: {what's unclear}]

### Data Requirements

- FR-010: System MUST {data requirement}
- FR-011: System MUST {data requirement}

### Integration Requirements

- FR-020: System MUST {integration requirement}

---

## Non-Functional Requirements

### Performance

- NFR-001: {operation} MUST complete in <{X}ms (p95)
- NFR-002: System MUST handle {N} concurrent {operations}

### Security

- NFR-010: {security requirement}
- NFR-011: {security requirement}

### Reliability

- NFR-020: {availability/durability requirement}

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: {Quantifiable metric with specific number}
- SC-002: {Quantifiable metric with specific number}
- SC-003: {Quantifiable metric with specific number}

**Measurement approach:** {how will these be verified - tests, metrics, user feedback}

---

## Out of Scope

Explicitly NOT part of this feature:

- {Related feature to defer}
- {Edge case to ignore}
- {Integration to skip}
- {User type not supported}

---

## Open Questions

Questions requiring stakeholder input before finalizing:

1. {Question} [NEEDS CLARIFICATION: {context}]
2. {Question} [NEEDS CLARIFICATION: {context}]

---

## Dependencies

External factors this feature depends on:

- {Existing system/API}
- {Other feature that must exist}
- {External service}

---

## Risks

Known risks and mitigation thoughts (not solutions):

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| {risk} | High/Med/Low | {general approach, not implementation} |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| {domain term} | {meaning in this context} |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| {date} | Initial draft | {name} |
```

---

## Section Guidelines

### User Scenarios

**Purpose:** Capture user intent, not system behavior.

**Good:**
> As a customer, I want to save my cart so that I can return later and complete purchase

**Bad:**
> As a user, I want the system to persist cart state to Redis with 24h TTL

**Acceptance scenarios** use Given/When/Then:
- **Given** - precondition/context
- **When** - action taken
- **Then** - observable outcome

Cover happy path + 2-3 edge cases per scenario.

### Functional Requirements

**RFC 2119 keywords:**

| Keyword | Meaning | Use When |
|---------|---------|----------|
| MUST | Absolute requirement | Feature fails without this |
| MUST NOT | Absolute prohibition | Violating breaks system |
| SHOULD | Strong recommendation | Exceptions need justification |
| SHOULD NOT | Strong discouragement | Doing this is problematic |
| MAY | Optional | Nice-to-have, can defer |

**Good FR:**
> FR-001: System MUST reject passwords shorter than 8 characters

**Bad FR:**
> FR-001: System MUST use bcrypt with cost factor 12

(The bad one specifies HOW, not WHAT)

### Success Criteria

**Must be measurable:**

| Bad | Good |
|-----|------|
| "Fast response times" | "API responds in <200ms (p95)" |
| "High availability" | "99.9% uptime measured monthly" |
| "User-friendly" | "80% of users complete flow without help" |
| "Secure" | "Zero credential leaks in security audit" |

### Out of Scope

**Why critical:** Prevents scope creep. When someone asks "can we also add X?", point to Out of Scope.

Include:
- Related features for future specs
- Edge cases you're consciously ignoring
- User types not supported in v1
- Integrations deferred

### NEEDS CLARIFICATION Markers

**Syntax:** `[NEEDS CLARIFICATION: {specific question}]`

**Good markers:**
```
[NEEDS CLARIFICATION: max file upload size?]
[NEEDS CLARIFICATION: which OAuth providers to support?]
[NEEDS CLARIFICATION: retry policy for failed emails?]
```

**Bad markers:**
```
[NEEDS CLARIFICATION: how to implement?]  # That's arch-lead's job
[NEEDS CLARIFICATION: ???]  # Not specific
[NEEDS CLARIFICATION: need more info]  # What info?
```

Categories:
- **Business:** Rules, thresholds, policies
- **Scope:** What's in/out
- **Edge cases:** Error handling, limits
- **Technical:** Feasibility (arch-lead resolves)
- **UX:** User expectations

---

## Anti-Patterns

### Implementation Leakage

**Bad:**
```markdown
## Functional Requirements
- FR-001: System MUST store users in PostgreSQL
- FR-002: System MUST use JWT tokens with 1h expiry
- FR-003: System MUST cache sessions in Redis
```

**Good:**
```markdown
## Functional Requirements
- FR-001: System MUST persist user accounts
- FR-002: System MUST maintain authenticated sessions
- FR-003: System MUST support session timeout after inactivity
```

### Vague Requirements

**Bad:**
```markdown
- FR-001: System MUST be fast
- FR-002: System MUST handle errors gracefully
- FR-003: System MUST be secure
```

**Good:**
```markdown
- FR-001: System MUST respond to searches in <500ms
- FR-002: System MUST display user-friendly error messages for all failures
- FR-003: System MUST encrypt passwords at rest
```

### Missing Acceptance Criteria

**Bad:**
```markdown
### US1: User Login
As a user, I want to log in.
```

**Good:**
```markdown
### US1: [P1] User Login
As a returning user, I want to log in with my credentials so that I can access my account.

**Acceptance Scenarios:**
- Given valid credentials, When I submit, Then I'm redirected to dashboard
- Given invalid password, When I submit, Then error shown, account not locked
- Given 5 failed attempts, When I try again, Then account locked for 15 minutes
```
