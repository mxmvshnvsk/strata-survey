// Kaplan–Meier survival of lines of code.
//
// Every line ever written is a subject. It "dies" when a commit changes or deletes
// it; lines still alive at HEAD are censored ("survived at least this long"). The
// estimator handles censoring properly, so young code does not drag the curve down.

export interface KaplanMeier {
  /** S(t) at the end of every age bin. */
  curve: number[];
  /** Number of subjects (lines ever written). */
  total: number;
  /** Age (in bins, fractional) at which S drops to 0.5: the half-life. Null if it never does. */
  median: number | null;
}

/** Kaplan–Meier estimator over binned ages. */
export function kaplanMeier(deaths: ArrayLike<number>, censored: ArrayLike<number>): KaplanMeier {
  const nb = deaths.length;
  let atRisk = 0;
  for (let i = 0; i < nb; i++) atRisk += deaths[i] + censored[i];
  const total = atRisk;
  const curve: number[] = [];
  let s = 1;
  let median: number | null = null;
  for (let i = 0; i < nb; i++) {
    if (atRisk <= 0) break;
    const prev = s;
    s *= 1 - deaths[i] / atRisk;
    curve.push(s);
    if (median === null && s <= 0.5) {
      // linear interpolation inside the bin
      const frac = prev === s ? 0 : (prev - 0.5) / (prev - s);
      median = i + frac;
    }
    atRisk -= deaths[i] + censored[i];
  }
  return { curve, total, median };
}
