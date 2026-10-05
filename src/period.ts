// Strata width: one stratum per year for long histories, per quarter or month for young ones.

import type { Timestamp, Bucket } from './types.ts';

const DAY = 86400;

export interface Period {
  /** Stratum index of a moment in time (may fall outside 0..count-1 for odd dates). */
  bucketOf(t: Timestamp): Bucket;
  count: number;
  unit: 'year' | 'quarter' | 'month';
  label(i: Bucket): string;
  startOf(i: Bucket): Timestamp;
}

export function makePeriod(tStart: Timestamp, tEnd: Timestamp): Period {
  const s = new Date(tStart * 1000);
  const e = new Date(tEnd * 1000);
  const years = (tEnd - tStart) / (365.25 * DAY);
  const y0 = s.getUTCFullYear();

  if (years > 5) {
    return {
      bucketOf: (t) => new Date(t * 1000).getUTCFullYear() - y0,
      count: e.getUTCFullYear() - y0 + 1,
      unit: 'year',
      label: (i) => String(y0 + i),
      startOf: (i) => Date.UTC(y0 + i, 0, 1) / 1000,
    };
  }

  const months = years > 1.5 ? 3 : 1;
  const m0 = s.getUTCMonth() - (s.getUTCMonth() % months);
  const bucketOf = (t: Timestamp): Bucket => {
    const d = new Date(t * 1000);
    return Math.floor(((d.getUTCFullYear() - y0) * 12 + d.getUTCMonth() - m0) / months);
  };
  return {
    bucketOf,
    count: bucketOf(tEnd) + 1,
    unit: months === 3 ? 'quarter' : 'month',
    label: (i) => {
      const mm = m0 + i * months;
      const y = y0 + Math.floor(mm / 12);
      const m = mm % 12;
      return months === 3 ? `${y} Q${Math.floor(m / 3) + 1}` : `${y}-${String(m + 1).padStart(2, '0')}`;
    },
    startOf: (i) => {
      const mm = m0 + i * months;
      return Date.UTC(y0 + Math.floor(mm / 12), mm % 12, 1) / 1000;
    },
  };
}
