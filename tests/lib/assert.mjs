// A deliberately small assertion collector: a suite records results and keeps
// going, so one run reports every problem rather than the first.
export function createRecorder(suiteName) {
  const results = [];
  return {
    results,
    ok(label, condition, detail = "") {
      results.push({ label, pass: !!condition, detail: condition ? "" : String(detail) });
      return !!condition;
    },
    // Assert a number is within `tolerance` of `expected`.
    near(label, actual, expected, tolerance, unit = "") {
      const pass = Math.abs(actual - expected) <= tolerance;
      return this.ok(label, pass, `${actual}${unit} vs ${expected}±${tolerance}${unit}`);
    },
    noErrors(page) {
      const errs = page.pageErrors || [];
      return this.ok("no JS errors", errs.length === 0, errs.join(" | "));
    },
    get failed() {
      return results.filter((r) => !r.pass);
    },
    get suite() {
      return suiteName;
    },
  };
}
