/**
 * v3.4 mini-bench demo — run the BUILTIN_SUITE through the bench
 * harness and show the per-case pass/fail.
 */
import { runSuite, BUILTIN_SUITE } from '../../packages/coding-agent/dist/bench/bench-harness.js';

console.log('============================================================');
console.log('  Deqi v3.4 mini-bench  —  6 cases in the BUILTIN_SUITE');
console.log('============================================================\n');

const result = await runSuite(BUILTIN_SUITE);
console.log(`  total:  ${result.total}`);
console.log(`  pass:   ${result.pass}`);
console.log(`  fail:   ${result.fail}\n`);

console.log('  per-case:');
for (const r of result.results) {
  const tag = r.pass ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`    ${tag}  ${r.caseId.padEnd(28)} ${r.name}`);
  for (const d of r.details) {
    console.log(`           ${d}`);
  }
}

console.log('\n============================================================');
