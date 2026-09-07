// Deliberately invalid examples: Semgrep's annotated rule fixtures, not application code.
// ruleid: no-unvalidated-json-cast
const parsed = JSON.parse(input) as Record<string, string>;
// ok: no-unvalidated-json-cast
const decoded: unknown = JSON.parse(input);
// ruleid: no-double-assertion
const coerced = value as unknown as Session;
// ok: no-double-assertion
const typed: Session = decodeSession(value);
// ruleid: no-empty-catch
try {
  save();
} catch (error) {}
// ok: no-empty-catch
try {
  save();
} catch (error) {
  report(error);
}
// ruleid: no-dynamic-code
eval(input);
// ruleid: no-dynamic-code
new Function(input);
// ok: no-dynamic-code
handlers.get(operation)?.(input);
// ruleid: no-ambient-sdk-state
const now = Date.now();
// ruleid: no-ambient-sdk-state
const random = Math.random();
// ok: no-ambient-sdk-state
const time = clock.now();
