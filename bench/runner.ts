/**
 * Benchmark runner
 *
 * Runs all benchmark suites and reports results.
 */

export async function runAllBenchmarks(): Promise<void> {
  const { runB1 } = await import('./suites/b1_simple_edit.js');
  const { runB2 } = await import('./suites/b2_multifile_refactor.js');
  const { runB3 } = await import('./suites/b3_fix_failing_test.js');
  const { runB4 } = await import('./suites/b4_interactive_reliability.js');
  const { runB5 } = await import('./suites/b5_safety_escape.js');
  const suites = [
    ['B1 simple edit', runB1],
    ['B2 multi-file transaction', runB2],
    ['B3 verification command', runB3],
    ['B4 interactive reliability', runB4],
    ['B5 safety escape', runB5],
  ] as const;
  let failed = 0;
  for (const [name, run] of suites) {
    const outcome = await run();
    const passed = typeof outcome === 'boolean' ? outcome : outcome.passed;
    process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${name}\n`);
    if (typeof outcome !== 'boolean' && outcome.metrics)
      process.stdout.write(`  metrics ${JSON.stringify(outcome.metrics)}\n`);
    if (!passed) failed += 1;
  }
  if (failed > 0) process.exitCode = 1;
}

runAllBenchmarks().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
