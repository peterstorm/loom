Emit exactly one JSON object conforming to reviewer-payload-schema; apply reviewer-impact-rubric. No other final output.

The final-message contract above is the deterministic fallback: it governs extraction-only requests outright, and it is the fallback when an emission-enabled request's registered tool is unavailable or refuses the arguments. On an emission-enabled request the engine renders the tool-primary wording below with the exact issued tool name substituted for the placeholder. Call that tool exactly once as the primary final action and never re-emit within the same spawn — a second call is refused as duplicate-call ambiguity — and the fallback final message carries exactly the one issued payload object, nothing else.

## emission-tool-contract (tool-primary)

```
Emit the required payload by calling the exact tool <issued emission tool name> exactly once, with its arguments carrying the complete issued payload, and make that tool call your primary final action. Never call <issued emission tool name> a second time in this spawn. Only if the tool is unavailable or refuses your arguments, fall back to the final message: exactly one JSON object conforming to the issued payload schema, and nothing else.
```

## reviewer-payload-schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "$ref": "#/$defs/__schema0"
    },
    {
      "$ref": "#/$defs/__schema13"
    }
  ],
  "description": "Exactly one strict JSON object, at most 1048576 UTF-8 bytes, no BOM, duplicate keys or more than 32 nested containers including root. Byte decoder enforces these limits before schema parsing. Evidence is reviewer-reported, never engine proof.",
  "$defs": {
    "__schema0": {
      "readOnly": true,
      "type": "object",
      "properties": {
        "schemaVersion": {
          "type": "number",
          "const": 2
        },
        "kind": {
          "type": "string",
          "const": "standalone-review"
        },
        "findings": {
          "$ref": "#/$defs/__schema1"
        }
      },
      "required": [
        "schemaVersion",
        "kind",
        "findings"
      ],
      "additionalProperties": false
    },
    "__schema1": {
      "readOnly": true,
      "maxItems": 128,
      "type": "array",
      "items": {
        "$ref": "#/$defs/__schema2"
      }
    },
    "__schema2": {
      "oneOf": [
        {
          "readOnly": true,
          "type": "object",
          "properties": {
            "severity": {
              "$ref": "#/$defs/__schema3"
            },
            "file": {
              "$ref": "#/$defs/__schema4"
            },
            "line": {
              "$ref": "#/$defs/__schema6"
            },
            "claim": {
              "$ref": "#/$defs/__schema7"
            },
            "basis": {
              "$ref": "#/$defs/__schema8"
            }
          },
          "required": [
            "severity",
            "file",
            "line",
            "claim",
            "basis"
          ],
          "additionalProperties": false,
          "description": "A null file requires a null line."
        },
        {
          "readOnly": true,
          "type": "object",
          "properties": {
            "severity": {
              "$ref": "#/$defs/__schema11"
            },
            "file": {
              "$ref": "#/$defs/__schema4"
            },
            "line": {
              "$ref": "#/$defs/__schema6"
            },
            "claim": {
              "$ref": "#/$defs/__schema7"
            },
            "reason": {
              "$ref": "#/$defs/__schema7"
            },
            "basis": {
              "$ref": "#/$defs/__schema12"
            }
          },
          "required": [
            "severity",
            "file",
            "line",
            "claim",
            "reason"
          ],
          "additionalProperties": false,
          "description": "A null file requires a null line. Optional basis must be complete, never null."
        }
      ]
    },
    "__schema3": {
      "type": "string",
      "const": "critical"
    },
    "__schema4": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048,
          "description": "1–2048 UTF-8 bytes; canonical parseReviewPath repository-relative POSIX path; must belong to issued frozen scope (checked by ingress).",
          "$ref": "#/$defs/__schema5"
        },
        {
          "type": "null"
        }
      ]
    },
    "__schema5": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2048,
      "description": "1–2048 UTF-8 bytes; non-whitespace; no NUL or unpaired Unicode surrogates. Preserve accepted contents exactly."
    },
    "__schema6": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "__schema7": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096,
      "description": "1–4096 UTF-8 bytes; non-whitespace; no NUL or unpaired Unicode surrogates. Preserve accepted contents exactly."
    },
    "__schema8": {
      "readOnly": true,
      "type": "object",
      "properties": {
        "evidence": {
          "oneOf": [
            {
              "readOnly": true,
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "reproduction"
                },
                "execution": {
                  "type": "string",
                  "enum": [
                    "not-executed",
                    "reviewer-reported"
                  ]
                },
                "setup": {
                  "$ref": "#/$defs/__schema9"
                },
                "input": {
                  "$ref": "#/$defs/__schema9"
                },
                "observed": {
                  "$ref": "#/$defs/__schema9"
                },
                "expected": {
                  "$ref": "#/$defs/__schema9"
                },
                "reference": {
                  "$ref": "#/$defs/__schema5"
                }
              },
              "required": [
                "kind",
                "execution",
                "setup",
                "input",
                "observed",
                "expected",
                "reference"
              ],
              "additionalProperties": false
            },
            {
              "readOnly": true,
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "execution-trace"
                },
                "preconditions": {
                  "$ref": "#/$defs/__schema10"
                },
                "steps": {
                  "$ref": "#/$defs/__schema10"
                },
                "observed": {
                  "$ref": "#/$defs/__schema9"
                },
                "expected": {
                  "$ref": "#/$defs/__schema9"
                },
                "reference": {
                  "$ref": "#/$defs/__schema5"
                }
              },
              "required": [
                "kind",
                "preconditions",
                "steps",
                "observed",
                "expected",
                "reference"
              ],
              "additionalProperties": false
            }
          ]
        },
        "violatedContract": {
          "readOnly": true,
          "type": "object",
          "properties": {
            "reference": {
              "$ref": "#/$defs/__schema5"
            },
            "statement": {
              "$ref": "#/$defs/__schema9"
            }
          },
          "required": [
            "reference",
            "statement"
          ],
          "additionalProperties": false
        },
        "consequence": {
          "readOnly": true,
          "type": "object",
          "properties": {
            "affected": {
              "$ref": "#/$defs/__schema9"
            },
            "preconditions": {
              "$ref": "#/$defs/__schema9"
            },
            "impact": {
              "$ref": "#/$defs/__schema9"
            },
            "evidenceLimits": {
              "$ref": "#/$defs/__schema9"
            }
          },
          "required": [
            "affected",
            "preconditions",
            "impact",
            "evidenceLimits"
          ],
          "additionalProperties": false
        },
        "truthConfidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "severityRationale": {
          "$ref": "#/$defs/__schema7"
        }
      },
      "required": [
        "evidence",
        "violatedContract",
        "consequence",
        "truthConfidence",
        "severityRationale"
      ],
      "additionalProperties": false
    },
    "__schema9": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8192,
      "description": "1–8192 UTF-8 bytes; non-whitespace; no NUL or unpaired Unicode surrogates. Preserve accepted contents exactly."
    },
    "__schema10": {
      "readOnly": true,
      "type": "array",
      "prefixItems": [
        {
          "$ref": "#/$defs/__schema9"
        }
      ],
      "items": {
        "$ref": "#/$defs/__schema9"
      },
      "maxItems": 32
    },
    "__schema11": {
      "type": "string",
      "const": "advisory"
    },
    "__schema12": {
      "$ref": "#/$defs/__schema8"
    },
    "__schema13": {
      "readOnly": true,
      "type": "object",
      "properties": {
        "schemaVersion": {
          "type": "number",
          "const": 2
        },
        "kind": {
          "type": "string",
          "const": "wave-review"
        },
        "packetId": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$",
          "description": "Must equal the issued Review Packet ID."
        },
        "generation": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991,
          "description": "Must equal the issued Review Generation."
        },
        "prior_findings": {
          "readOnly": true,
          "description": "Every issued prior Finding ID exactly once in packet order; empty roster requires empty array. Ingress checks the issued roster.",
          "$ref": "#/$defs/__schema14"
        },
        "findings": {
          "$ref": "#/$defs/__schema1"
        }
      },
      "required": [
        "schemaVersion",
        "kind",
        "packetId",
        "generation",
        "prior_findings",
        "findings"
      ],
      "additionalProperties": false
    },
    "__schema14": {
      "maxItems": 4096,
      "type": "array",
      "items": {
        "$ref": "#/$defs/__schema15"
      }
    },
    "__schema15": {
      "readOnly": true,
      "type": "object",
      "properties": {
        "finding_id": {
          "$ref": "#/$defs/__schema5"
        },
        "verdict": {
          "type": "string",
          "enum": [
            "resolved_by_remediation",
            "still_present"
          ]
        },
        "reason": {
          "$ref": "#/$defs/__schema9"
        }
      },
      "required": [
        "finding_id",
        "verdict",
        "reason"
      ],
      "additionalProperties": false
    }
  }
}
```

## Current example (standalone)

```json
{
  "schemaVersion": 2,
  "kind": "standalone-review",
  "findings": [
    {
      "severity": "critical",
      "file": null,
      "line": null,
      "claim": "Supported input can be accepted without the required authorization check.",
      "basis": {
        "evidence": {
          "kind": "execution-trace",
          "preconditions": [
            "An unauthenticated caller reaches the supported entry point."
          ],
          "steps": [
            "Trace the entry point to the write without encountering authorization."
          ],
          "observed": "Predicted unauthorized write; not executed.",
          "expected": "Reject before writing.",
          "reference": "Entry-point control flow"
        },
        "violatedContract": {
          "reference": "Project authorization obligation",
          "statement": "Writes require authorization."
        },
        "consequence": {
          "affected": "Stored user data",
          "preconditions": "Unauthenticated supported request",
          "impact": "Unauthorized modification",
          "evidenceLimits": "Static trace only; no execution receipt."
        },
        "truthConfidence": 80,
        "severityRationale": "The reachable authorization violation blocks safe delivery."
      }
    }
  ]
}
```

## reviewer-impact-rubric

Classify one assertion per finding. Truth confidence concerns whether that assertion holds; it is not an impact score or a severity formula.

Use critical only for a concrete consequence to supported behavior, safety or authority, an explicit acceptance or verification obligation, or safe operator use that must block this delivery. Identify the affected party or system, supported preconditions, violated contract and evidence limits. Explicit non-negotiable project obligations remain binding; cite the actual obligation and consequence.

Factual incorrectness, high confidence, stylistic preference, architectural shallowness, or a missing test alone does not establish a blocking consequence. Use advisory for a nonblocking correction or improvement, with a concise reason or benefit. A fuller advisory basis is optional, but if supplied must be complete.

For a critical, provide the claim plus evidence or a concrete execution trace, violated contract, consequence, truth confidence, and severity rationale. A reproduction is not universally required. Do not claim execution merely because a command or reference is written down. Reviewer-reported execution is not an engine execution receipt; identify what was not observed or proved.

Use an honest null location rather than invent a file or line. Finding locations must be inside the frozen scope; references supply context, not permission to expand that scope. Assess every prior Finding ID exactly once in packet order when the issued contract requires it. Do not intentionally re-emit a prior Finding as new.

The engine validates structure, attribution, scope, identity, complete evidence and arithmetic. It does not prove truth, impact, reachability, or semantic test adequacy from these fields. Never invent new Finding IDs or numeric tallies; return only the one JSON object required by the issued schema.

The existing Refutation Panel may refute an assertion, including its stated preconditions, contract and consequence, but a true assertion is not refuted merely because its repair seems unimportant. A structurally admitted surviving critical remains blocking. There is no automatic severity downgrade or new severity-dispute action.
