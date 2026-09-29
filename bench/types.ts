export interface BenchmarkResult {
  passed: boolean;
  metrics?: Record<string, number>;
}

export type BenchmarkOutcome = boolean | BenchmarkResult;
