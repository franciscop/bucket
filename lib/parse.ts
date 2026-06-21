// Copied from github.com/franciscop/polystore
const times = /(-?(?:\d+\.?\d*|\d*\.?\d+)(?:e[-+]?\d+)?)\s*([\p{L}]*)/iu;

interface ParseFunction {
  (str: string | number | null | undefined): number | null;
  millisecond: number;
  ms: number;
  second: number;
  sec: number;
  s: number;
  "": number;
  minute: number;
  min: number;
  m: number;
  hour: number;
  hr: number;
  h: number;
  day: number;
  d: number;
  week: number;
  wk: number;
  w: number;
  year: number;
  yr: number;
  y: number;
  month: number;
  b: number;
  [key: string]:
    | number
    | ((str: string | number | null | undefined) => number | null);
}

const parse = function (
  str: string | number | null | undefined,
): number | null {
  if (str === null || str === undefined) return null;
  if (typeof str === "number") return str;
  const cleaned = str.toLowerCase().replace(/[,_]/g, "");
  const [, value, units] = times.exec(cleaned) || [];
  if (!units) return null;
  const unitValue =
    (parse as ParseFunction)[units] ??
    (parse as ParseFunction)[units.replace(/s$/, "")];
  if (!unitValue) return null;
  return Math.abs(
    Math.round(parseFloat(value) * (unitValue as number) * 1000) / 1000,
  );
} as ParseFunction;

parse.millisecond = parse.ms = 0.001;
parse.second = parse.sec = parse.s = parse[""] = 1;
parse.minute = parse.min = parse.m = parse.s * 60;
parse.hour = parse.hr = parse.h = parse.m * 60;
parse.day = parse.d = parse.h * 24;
parse.week = parse.wk = parse.w = parse.d * 7;
parse.year = parse.yr = parse.y = parse.d * 365.25;
parse.month = parse.b = parse.y / 12;

export default parse;
