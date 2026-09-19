import BucketError from "./BucketError.ts";

const invalid = (got: unknown, required: boolean): never => {
  const describe =
    got === undefined
      ? "no filter"
      : got === null
        ? "null"
        : typeof got === "string"
          ? `the string ${JSON.stringify(got)}`
          : `a ${typeof got}`;
  throw new BucketError(
    `${required ? "remove() needs" : "expected"} a RegExp filter, got ${describe}. ` +
      `Use .remove(/./) to empty it, .folder(path) to scope it, or a RegExp ` +
      `like .remove(/\\.tmp$/) to match by name.`,
    { code: "INVALID_FILTER" },
  );
};

/** For list()/scan()/count(), where the filter is optional but still typed. */
export function assertFilter(
  filter: unknown,
): asserts filter is RegExp | undefined {
  if (filter === undefined || filter instanceof RegExp) return;
  invalid(filter, false);
}

/** For remove(), where a filter is mandatory: no argument would delete every
 * file, which is too easy to do by accident with an undefined variable. */
export function requireFilter(filter: unknown): asserts filter is RegExp {
  if (filter instanceof RegExp) return;
  invalid(filter, true);
}
