export interface Agg {
  median: number;
  mean: number;
  stddev: number;
  cv: number;
  min: number;
  max: number;
}

export function aggregate(values: number[]): Agg {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const median = n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return { median, mean, stddev, cv: mean ? stddev / mean : 0, min: xs[0], max: xs[n - 1] };
}
