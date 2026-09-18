// From https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types/Common_types
const fileTypes: Record<string, string> = {
  aac: "audio/aac",
  abw: "application/x-abiword",
  arc: "application/x-freearc",
  avif: "image/avif",
  avi: "video/x-msvideo",
  azw: "application/vnd.amazon.ebook",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  bz: "application/x-bzip",
  bz2: "application/x-bzip2",
  cda: "application/x-cdf",
  csh: "application/x-csh",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eot: "application/vnd.ms-fontobject",
  epub: "application/epub+zip",
  gz: "application/gzip",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ico: "image/vnd.microsoft.icon",
  ics: "text/calendar",
  jar: "application/java-archive",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  jsonld: "application/ld+json",
  md: "text/markdown",
  mid: "audio/midi",
  midi: "audio/midi",
  mjs: "text/javascript",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpkg: "application/vnd.apple.installer+xml",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  oga: "audio/ogg",
  ogv: "video/ogg",
  ogx: "application/ogg",
  opus: "audio/opus",
  otf: "font/otf",
  png: "image/png",
  pdf: "application/pdf",
  php: "application/x-httpd-php",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rar: "application/vnd.rar",
  rtf: "application/rtf",
  sh: "application/x-sh",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  text: "text/plain",
  tif: "image/tiff",
  tiff: "image/tiff",
  ts: "video/mp2t",
  ttf: "font/ttf",
  txt: "text/plain",
  vsd: "application/vnd.visio",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xhtml: "application/xhtml+xml",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  xul: "application/vnd.mozilla.xul+xml",
  zip: "application/zip",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  "7z": "application/x-7z-compressed",
};

export function getContentType(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? fileTypes[ext] : undefined;
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
  return isExtension(value) ? fileTypes[bare(value)] : value;
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
    for (const [ext, mime] of Object.entries(fileTypes))
      extensions[mime] ??= ext;
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

export default fileTypes;
