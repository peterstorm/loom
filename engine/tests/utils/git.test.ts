import { describe, it, expect } from "vitest";
import { countNewTests, countAssertions } from "../../src/utils/git";

describe("countNewTests (pure)", () => {
  it("counts Java @Test annotations", () => {
    const diff = [
      "+    @Test",
      "+    void shouldValidateOrder() {",
      "+    @Property",
      "+    void orderTotalInvariant() {",
      "-    @Test",
      "     void existingTest() {",
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.java).toBe(2);
    expect(result.total).toBe(2);
  });

  it("counts TypeScript it/test/describe blocks", () => {
    const diff = [
      '+  it("should validate input", () => {',
      '+  test("handles edge case", () => {',
      '+  describe("validation", () => {',
      '-  it("old test", () => {',
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.ts).toBe(3);
    expect(result.total).toBe(3);
  });

  it("counts Python test functions and classes", () => {
    const diff = [
      "+def test_validates_input():",
      "+class TestValidation:",
      "+    def test_edge_case(self):",
      "-def test_old():",
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.python).toBe(3);
    expect(result.total).toBe(3);
  });

  it("returns zeros for no tests", () => {
    const diff = ["+const x = 42;", "+function doStuff() {}"].join("\n");
    const result = countNewTests(diff);
    expect(result.total).toBe(0);
  });

  it("handles mixed languages", () => {
    const diff = [
      "+    @Test",
      '+  it("foo", () => {',
      "+def test_bar():",
    ].join("\n");
    const result = countNewTests(diff);
    expect(result.java).toBe(1);
    expect(result.ts).toBe(1);
    expect(result.python).toBe(1);
    expect(result.total).toBe(3);
  });
});

describe("countAssertions (pure)", () => {
  it("counts Java assertions", () => {
    const diff = [
      "+    assertThat(result).isEqualTo(expected);",
      "+    assertThrows(Exception.class, () -> run());",
      "+    verify(mock).someMethod();",
    ].join("\n");
    expect(countAssertions(diff)).toBe(3);
  });

  it("counts TypeScript assertions", () => {
    const diff = [
      "+    expect(result).toBe(42);",
      "+    expect(fn).toThrow();",
      "+    expect(arr).toEqual([1, 2]);",
    ].join("\n");
    expect(countAssertions(diff)).toBe(3);
  });

  it("counts Python assertions", () => {
    const diff = [
      "+    assert result == 42",
      "+    assertIn('key', data)",
    ].join("\n");
    expect(countAssertions(diff)).toBe(2);
  });

  it("ignores removed lines", () => {
    const diff = [
      "-    expect(old).toBe(true);",
      "+    const x = 1;",
    ].join("\n");
    expect(countAssertions(diff)).toBe(0);
  });
});
