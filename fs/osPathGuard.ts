import BucketError from "../lib/BucketError.ts";

// On POSIX an OS-absolute path and a bucket-anchored path share the same
// syntax, so a 0.4-style absolute input like file("/data/uploads/a.png") on a
// bucket rooted at "/data" would silently become the key "data/uploads/a.png"
// (reads miss, writes nest a phantom directory chain). Catch the one
// deterministic signature of that mistake: the input starting with the
// bucket's own root. The anchored spelling is never the only one (drop the
// leading part, or use "../" from a folder), so nothing becomes unreachable.
export default function assertNotOsPath(root: string, path: string): void {
  if (path !== root && !path.startsWith(root + "/")) return;
  const rest = path.slice(root.length).replace(/^\/+/, "");
  throw new BucketError(
    `"${path}" looks like an OS path; paths are relative to the bucket ("${root}")` +
      (rest ? `. Did you mean "${rest}"?` : ""),
    { code: "INVALID_PATH" },
  );
}
