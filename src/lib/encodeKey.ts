// How a bucket key goes into a URL, for every provider. Encoding it in full
// keeps "?", "#", "+" and "%" part of the key instead of the URL's syntax.

/** RFC 3986: like encodeURIComponent, but !'()* are encoded too. */
export const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

/** A key as a URL path: every segment encoded, "/" kept. */
export const encodeKey = (key: string): string =>
  key.split("/").map(rfc3986).join("/");
