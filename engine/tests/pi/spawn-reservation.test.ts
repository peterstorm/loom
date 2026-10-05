import { describe, expect, it } from "vitest";
import { createPiParentSessions } from "../../../pi/spawn-reservation";
import { parseSessionId } from "../../src/machine";

describe("createPiParentSessions", () => {
  const sessionId = parseSessionId("019fca39-f989-7510-8e62-50dadbcad480")!;

  it("creates one runtime per session on first use and returns the same one after", () => {
    const sessions = createPiParentSessions();
    expect(sessions.get(sessionId)).toBeUndefined();
    const runtime = sessions.runtimeFor(sessionId);
    expect(sessions.runtimeFor(sessionId)).toBe(runtime);
    expect(sessions.get(sessionId)).toBe(runtime);
  });

  it("prunes a runtime only once it holds no grant and no reservation", () => {
    const sessions = createPiParentSessions();
    const runtime = sessions.runtimeFor(sessionId);
    runtime.issuedWriteGrants.set("call-1", ["token"]);
    sessions.prune(sessionId, runtime);
    expect(sessions.get(sessionId)).toBe(runtime);
    runtime.issuedWriteGrants.delete("call-1");
    sessions.prune(sessionId, runtime);
    expect(sessions.get(sessionId)).toBeUndefined();
  });
});
