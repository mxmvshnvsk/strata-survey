// Text of the findings, number/date formatting and the strata palette.
//
// Shared by the CLI (imported as a module) and the HTML report, where it is inlined
// as a plain script: render.ts strips the types and the `export` keywords.
// So: no runtime imports here, only `import type`.

import type { Fact, Lang } from './types.ts';

export const STRATA_LANGS: Lang[] = ['en', 'ru'];

/** Russian plural form for n: 1 строка, 2 строки, 5 строк. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export type Noun = 'line' | 'commit' | 'file' | 'change' | 'person' | 'commitIn';

const NOUNS_RU: Record<Noun, [string, string, string]> = {
  line: ['строка', 'строки', 'строк'], commit: ['коммит', 'коммита', 'коммитов'], file: ['файле', 'файлах', 'файлах'],
  change: ['изменение', 'изменения', 'изменений'], person: ['человек', 'человека', 'человек'], commitIn: ['коммите', 'коммитах', 'коммитах'],
};
const NOUNS_EN: Record<Noun, [string, string]> = {
  line: ['line', 'lines'], commit: ['commit', 'commits'], file: ['file', 'files'],
  change: ['change', 'changes'], person: ['person', 'people'], commitIn: ['commit', 'commits'],
};

/** Formatters for one language. */
export interface Fmt {
  lang: Lang;
  /** Escape for HTML. */
  esc(s: unknown): string;
  num(n: number): string;
  /** Share as a percentage with `d` decimals; tiny non-zero shares read "<1%". */
  pct(x: number, d?: number): string;
  date(t: number): string;
  month(t: number): string;
  /** A duration in days as "5 months", "1.4 years". */
  dur(days: number): string;
  /** A count with its noun: "1 line", "5 строк". */
  n(x: number, noun: Noun): string;
}

export function makeFmt(lang: Lang): Fmt {
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  const dec = lang === 'ru' ? ',' : '.';
  const nf = new Intl.NumberFormat(locale);
  const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const num = (n: number): string => nf.format(Math.round(n));
  const pct = (x: number, d = 0): string => {
    if (x > 0 && x * 100 < 0.5 * Math.pow(10, -d)) return '<' + (d ? '0' + dec + '1' : '1') + '%';
    return (x * 100).toFixed(d).replace('.', dec) + '%';
  };
  const date = (t: number): string => new Date(t * 1000)
    .toLocaleDateString(locale, { year: 'numeric', month: lang === 'ru' ? 'long' : 'short', day: 'numeric', timeZone: 'UTC' })
    .replace(/\s*г\.$/, '');
  const month = (t: number): string => new Date(t * 1000).toLocaleDateString(locale, { year: 'numeric', month: 'short', timeZone: 'UTC' });
  const n = (x: number, noun: Noun): string =>
    num(x) + ' ' + (lang === 'ru' ? pluralRu(Math.round(x), ...NOUNS_RU[noun]) : NOUNS_EN[noun][Math.round(x) === 1 ? 0 : 1]);
  const dur = (days: number): string => {
    const round = (v: number, d: number): string => (Math.abs(v - Math.round(v)) < 0.05 || v >= 10 ? String(Math.round(v)) : v.toFixed(d).replace('.', dec));
    if (days >= 365 * 0.95) {
      const s = round(days / 365.25, 1);
      if (lang === 'ru') return s.includes(',') ? s + ' года' : s + ' ' + pluralRu(Number(s), 'год', 'года', 'лет');
      return s + (s === '1' ? ' year' : ' years');
    }
    if (days >= 45) {
      const mo = Math.round(days / 30.44);
      return lang === 'ru' ? mo + ' ' + pluralRu(mo, 'месяц', 'месяца', 'месяцев') : mo + (mo === 1 ? ' month' : ' months');
    }
    const d = Math.round(days);
    return lang === 'ru' ? d + ' ' + pluralRu(d, 'день', 'дня', 'дней') : d + (d === 1 ? ' day' : ' days');
  };
  return { esc, num, pct, date, month, dur, lang, n };
}

/** Turns a fact's values into an HTML sentence (only <b> and <code>; values are escaped). */
export type FactTemplate = (v: any, f: Fmt) => string;

export const STRATA_FACTS: Record<Lang, Record<string, FactTemplate>> = {
  en: {
    shallow: (v: any, f: Fmt) => `<b>Shallow clone.</b> History starts on ${f.date(v.since)}; everything older is pressed into the bottom layer. Run <code>git fetch --unshallow</code> for a full survey.`,
    age: (v: any, f: Fmt) => `<b>${f.dur(v.years * 365.25)}</b> of sediment: ${f.n(v.commits, 'commit')} by ${f.n(v.people, 'person')} since ${f.date(v.since)}. Today it holds <b>${f.n(v.lines, 'line')}</b> in ${f.n(v.files, 'file')}.`,
    strata: (v: any, f: Fmt) => `Half of today's code was laid down in <b>${f.esc(v.median)}</b> or earlier. The deepest surviving stratum (${f.esc(v.oldest)}) still holds ${f.n(v.oldestLines, 'line')} (${f.pct(v.oldestShare, 1)}); the topsoil (${f.esc(v.newest)}) ${f.pct(v.newestShare, 1)}.`,
    durability: (v: any, f: Fmt) => `Most durable layer: <b>${f.esc(v.best)}</b> — ${f.pct(v.bestR)} of what was written then is still here. Most eroded: <b>${f.esc(v.worst)}</b>, only ${f.pct(v.worstR)} survived.`,
    halfLife: (v: any, f: Fmt) => `A line of code here has a <b>half-life of ${f.dur(v.days)}</b>${v.source ? ` (source: ${f.dur(v.source)}, tests: ${f.dur(v.tests)})` : ''} — half of all lines ever written were rewritten or deleted within that time.`,
    immortal: (v: any, f: Fmt) => `Code here is unusually stable: even after ${f.dur(v.days)}, ${f.pct(v.share)} of lines survive, so no half-life can be measured yet.`,
    hotspot: (v: any, f: Fmt) => `Hottest spot: <code>${f.esc(v.path)}</code> — ${f.n(v.loc, 'line')}, changed ${f.num(v.revs)} ${v.revs === 1 ? 'time' : 'times'}${v.recent ? ' in the last year' : ''}. Complex code that keeps changing is where bugs and slowdowns breed.`,
    coupling: (v: any, f: Fmt) => `Hidden coupling: <code>${f.esc(v.a)}</code> and <code>${f.esc(v.b)}</code> changed together in ${f.n(v.shared, 'commit')} (${f.pct(v.degree)} of the time).`,
    bus: (v: any, f: Fmt) => `Bus factor: <b>${v.bus}</b> ${v.bus === 1 ? 'person holds' : 'people hold'} more than half of all lines.${v.silo ? ` <code>${f.esc(v.silo)}</code> is a knowledge silo — ${f.esc(v.siloOwner)} wrote ${f.pct(v.siloShare)} of it.` : ''} ${f.pct(v.orphan)} of the code was written by people inactive for over a year.`,
    extinction: (v: any, f: Fmt) => `Greatest extinction: <code>${f.esc(v.h)}</code> “${f.esc(v.subject)}” by ${f.esc(v.author)} (${f.date(v.t)}) wiped out <b>${f.n(v.removedOld, 'line')}</b> older than a year.`,
    fossil: (v: any, f: Fmt) => `Oldest fossil: <code>${f.esc(v.path)}:${v.line}</code>, written by ${f.esc(v.author)} on ${f.date(v.t)} and untouched since: <code>${f.esc(v.text)}</code>`,
    trend: (v: any, f: Fmt) => v.prev === 0 ? `Activity: ${f.n(v.last, 'commit')} in the last year.` : `Activity: ${f.n(v.last, 'commit')} in the last 52 weeks, ${v.last >= v.prev ? 'up' : 'down'} ${f.pct(Math.abs(v.last - v.prev) / v.prev)} from the year before.`,
  },
  ru: {
    shallow: (v: any, f: Fmt) => `<b>Shallow-клон.</b> История начинается ${f.date(v.since)}; всё, что старше, спрессовано в нижний слой. Выполните <code>git fetch --unshallow</code> для полной съёмки.`,
    age: (v: any, f: Fmt) => `<b>${f.dur(v.years * 365.25)}</b> отложений: ${f.n(v.commits, 'commit')} от ${f.n(v.people, 'person')} с ${f.date(v.since)}. Сейчас здесь <b>${f.n(v.lines, 'line')}</b> в ${f.n(v.files, 'file')}.`,
    strata: (v: any, f: Fmt) => `Половина сегодняшнего кода отложилась в <b>${f.esc(v.median)}</b> или раньше. В самом глубоком уцелевшем слое (${f.esc(v.oldest)}) всё ещё ${f.n(v.oldestLines, 'line')} (${f.pct(v.oldestShare, 1)}); верхний слой (${f.esc(v.newest)}) — ${f.pct(v.newestShare, 1)}.`,
    durability: (v: any, f: Fmt) => `Самый прочный слой: <b>${f.esc(v.best)}</b> — от написанного тогда сохранилось ${f.pct(v.bestR)}. Самый размытый: <b>${f.esc(v.worst)}</b>, уцелело лишь ${f.pct(v.worstR)}.`,
    halfLife: (v: any, f: Fmt) => `<b>Период полураспада</b> строки кода здесь — <b>${f.dur(v.days)}</b>${v.source ? ` (исходники: ${f.dur(v.source)}, тесты: ${f.dur(v.tests)})` : ''}: за это время половина когда-либо написанных строк переписывается или удаляется.`,
    immortal: (v: any, f: Fmt) => `Код необычно стабилен: даже через ${f.dur(v.days)} живы ${f.pct(v.share)} строк, период полураспада пока не измерить.`,
    hotspot: (v: any, f: Fmt) => `Главная горячая точка: <code>${f.esc(v.path)}</code> — ${f.n(v.loc, 'line')}, ${f.n(v.revs, 'change')}${v.recent ? ' за последний год' : ''}. Сложный код, который постоянно меняют, — питомник багов.`,
    coupling: (v: any, f: Fmt) => `Скрытая связь: <code>${f.esc(v.a)}</code> и <code>${f.esc(v.b)}</code> менялись вместе в ${f.n(v.shared, 'commitIn')} (${f.pct(v.degree)} случаев).`,
    bus: (v: any, f: Fmt) => `Bus factor: <b>${v.bus}</b> — ${v.bus === 1 ? 'один человек владеет' : 'столько людей владеют'} больше чем половиной строк.${v.silo ? ` <code>${f.esc(v.silo)}</code> — силос знаний: ${f.esc(v.siloOwner)} написал(а) ${f.pct(v.siloShare)} этого модуля.` : ''} ${f.pct(v.orphan)} кода написано людьми, неактивными больше года.`,
    extinction: (v: any, f: Fmt) => `Великое вымирание: <code>${f.esc(v.h)}</code> «${f.esc(v.subject)}» от ${f.esc(v.author)} (${f.date(v.t)}) стёр <b>${f.n(v.removedOld, 'line')}</b> старше года.`,
    fossil: (v: any, f: Fmt) => `Древнейшее ископаемое: <code>${f.esc(v.path)}:${v.line}</code>, написано ${f.esc(v.author)} ${f.date(v.t)} и с тех пор не тронуто: <code>${f.esc(v.text)}</code>`,
    trend: (v: any, f: Fmt) => v.prev === 0 ? `Активность: ${f.n(v.last, 'commit')} за последний год.` : `Активность: ${f.n(v.last, 'commit')} за последние 52 недели — ${v.last >= v.prev ? 'рост' : 'спад'} на ${f.pct(Math.abs(v.last - v.prev) / v.prev)} к предыдущему году.`,
  },
};

/** [colour, English name, Russian name] of a geological period. */
export type PeriodInfo = [string, string, string];

// ICS chronostratigraphic colours: the oldest strata get Precambrian hues, the topsoil Quaternary yellow.
export const PERIODS: PeriodInfo[] = [
  ['#AE027E', 'Hadean', 'Гадей'], ['#F0047F', 'Archean', 'Архей'], ['#F74370', 'Paleoproterozoic', 'Палеопротерозой'],
  ['#FDB462', 'Mesoproterozoic', 'Мезопротерозой'], ['#FEB342', 'Neoproterozoic', 'Неопротерозой'],
  ['#7FA056', 'Cambrian', 'Кембрий'], ['#009270', 'Ordovician', 'Ордовик'], ['#B3E1B6', 'Silurian', 'Силур'],
  ['#CB8C37', 'Devonian', 'Девон'], ['#67A599', 'Carboniferous', 'Карбон'], ['#F04028', 'Permian', 'Пермь'],
  ['#812B92', 'Triassic', 'Триас'], ['#34B2C9', 'Jurassic', 'Юра'], ['#7FC64E', 'Cretaceous', 'Мел'],
  ['#FD9A52', 'Paleogene', 'Палеоген'], ['#FFE619', 'Neogene', 'Неоген'], ['#F9F97F', 'Quaternary', 'Четвертичный'],
];

/** Linear blend of two #rrggbb colours. */
export function mix(c1: string, c2: string, t: number): string {
  const rgb = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const a = rgb(c1), b = rgb(c2);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/** Colour and period name for each of `n` strata, oldest first. */
export function strataPalette(n: number): PeriodInfo[] {
  if (n <= PERIODS.length) return PERIODS.slice(PERIODS.length - n).map((p): PeriodInfo => [p[0], p[1], p[2]]);

  // More strata than periods: interpolate colours and subdivide period names
  // the way stratigraphers do (Early/Late Devonian; нижний/верхний девон).
  const out: PeriodInfo[] = [];
  const base: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (PERIODS.length - 1);
    const a = Math.floor(x), b = Math.min(PERIODS.length - 1, a + 1), t = x - a;
    const p = PERIODS[Math.round(x)];
    base.push(Math.round(x));
    out.push([mix(PERIODS[a][0], PERIODS[b][0], t), p[1], p[2]]);
  }
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
  const FEMININE = new Set(['Юра', 'Пермь']);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && base[j + 1] === base[i]) j++;
    const k = j - i + 1;
    if (k > 1) {
      for (let q = 0; q < k; q++) {
        const [col, en, ru] = out[i + q];
        const pos = k === 2 ? (q === 0 ? 0 : 2) : k === 3 ? q : -1;
        const numeral = ROMAN[q] || String(q + 1);
        const enName = pos < 0 ? `${en} ${numeral}` : `${['Early', 'Middle', 'Late'][pos]} ${en}`;
        const ruPrefix = FEMININE.has(ru) ? ['Нижняя', 'Средняя', 'Верхняя'][pos] : ['Нижний', 'Средний', 'Верхний'][pos];
        const ruName = ru === 'Четвертичный' || pos < 0 ? `${ru} ${numeral}` : `${ruPrefix} ${ru.toLowerCase()}`;
        out[i + q] = [col, enName, ruName];
      }
    }
    i = j + 1;
  }
  return out;
}

/** One finding as an HTML sentence in the given language. */
export function renderFact(fact: Fact, lang: Lang): string {
  const t = (STRATA_FACTS[lang] || STRATA_FACTS.en)[fact.k];
  return t ? t(fact.v, makeFmt(lang)) : '';
}
