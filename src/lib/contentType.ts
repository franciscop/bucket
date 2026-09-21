// Turning paths and `type` options into MIME types, and back.
import mimes from "./mimes.ts";

export function getContentType(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? mimes[ext] : undefined;
}

// A `type` option is an extension when it is plain alphanumeric ("png",
// ".png"); anything else is taken as a mime type ("image/png").
const isExtension = (type: string): boolean => /^\.?[a-zA-Z0-9]+$/.test(type);

const bare = (type: string): string =>
  type.trim().replace(/^\./, "").toLowerCase();

/** Mime type for a `type` option given as a mime type or an extension. */
export function toMime(type: string): string | undefined {
  const value = type.trim();
  if (!value) return undefined;
  return isExtension(value) ? mimes[bare(value)] : value;
}

// Several extensions share a mime type; these are the ones worth generating.
const PREFERRED: Record<string, string> = {
  "text/html": "html",
  "image/jpeg": "jpg",
  "text/javascript": "js",
  "audio/midi": "mid",
  "text/plain": "txt",
  "image/tiff": "tiff",
};

let extensions: Record<string, string> | null = null;

/** Extension for a `type` option ("image/png", "png" and ".png" all give
 * ".png"), or "" when the mime type maps to no known extension. */
export function getExtension(type: string): string {
  const value = type.trim();
  if (!value) return "";
  if (isExtension(value)) return "." + bare(value);
  if (!extensions) {
    extensions = { ...PREFERRED };
    for (const [ext, mime] of Object.entries(mimes)) extensions[mime] ??= ext;
  }
  const ext = extensions[value.split(";")[0].trim().toLowerCase()];
  return ext ? "." + ext : "";
}

// Content-type for a write: explicit option first, then the destination path's
// extension, then the type a Blob/File input carries. Undefined if none apply.
export function resolveContentType(
  path: string,
  content: unknown,
  options?: { type?: string },
): string | undefined {
  return (
    (options?.type ? toMime(options.type) : undefined) ??
    getContentType(path) ??
    (content instanceof Blob && content.type ? content.type : undefined)
  );
}

export default mimes;
