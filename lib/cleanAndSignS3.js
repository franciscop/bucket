import { createHash, createHmac } from "node:crypto";

const hash = (str) => {
  return createHash("sha256").update(str).digest("hex");
};

const khash = (key, str) => {
  return createHmac("sha256", key).update(str);
};

// Just copied from AWS
const encode = (str) => {
  const escape = (output) => {
    output = output.replace(/[^A-Za-z0-9_.~\-%]+/g, escape);
    output = output.replace(/[*]/g, function (ch) {
      return "%" + ch.charCodeAt(0).toString(16).toUpperCase();
    });
    return output;
  };
  return str.split("/").map(escape).join("/");
};

const canonical = ({ headers = {}, ...config } = {}) => {
  const url = new URL(config.url);
  const method = (config.method || "GET").toUpperCase();
  // Doesn't seem to make a difference, let's see later:
  // const path = encode(url.pathname);
  const path = url.pathname;
  url.searchParams.sort();
  const query = url.searchParams.toString();
  const headersPlain =
    Object.entries(headers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k.toLowerCase() + ":" + v.trim())
      .join("\n") + "\n"; // [SIC]
  const headerKeys = Object.keys(headers)
    .sort()
    .map((h) => h.toLowerCase())
    .join(";");
  const payload = hash(config.body || "");
  const canonical = [
    method,
    path,
    query,
    headersPlain,
    headerKeys,
    payload,
  ].join("\n");
  // console.log("Canonical:\n" + canonical);
  return canonical;
};

const getStringToSign = (request, region) => {
  const name = "AWS4-HMAC-SHA256";
  const timestamp = request.headers["x-amz-date"];
  const scope = [timestamp.slice(0, 8), region, "s3", "aws4_request"].join("/");
  const canon = hash(canonical(request));
  const stringToSign = [name, timestamp, scope, canon].join("\n");
  // console.log("String to sign:\n" + stringToSign);
  return stringToSign;
};

const createSignature = (request, key, region) => {
  if (!key) throw new Error("Key is required");
  const stringToSign = getStringToSign(request, region);

  const dateStamp = request.headers["x-amz-date"].slice(0, 8);
  const kDate = khash(`AWS4${key}`, dateStamp).digest();
  const kRegion = khash(kDate, region).digest();
  const kService = khash(kRegion, "s3").digest();
  const kSigning = khash(kService, "aws4_request").digest();
  const signature = khash(kSigning, stringToSign).digest("hex");
  // console.log("Signature:\n" + signature);
  return signature;
};

const createAuth = (auth, request) => {
  if (!auth.id) throw new Error("ID is required");
  if (!auth.key) throw new Error("KEY is required");
  const signature = createSignature(request, auth.key, auth.region);
  const date = request.headers["x-amz-date"].slice(0, 8);
  const credential = `${auth.id}/${date}/${auth.region}/s3/aws4_request`;
  const headers = Object.keys(request.headers)
    .sort()
    .map((h) => h.toLowerCase())
    .join(";");
  const header = `AWS4-HMAC-SHA256Credential=${credential},SignedHeaders=${headers},Signature=${signature}`;
  // console.log("Auth header:\n" + header);
  return header;
};

const sortValue = (obj = {}) => {
  return Object.fromEntries(
    Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([k, v]) => typeof v !== "undefined")
  );
};

const plainDate = () =>
  new Date()
    .toISOString()
    .replace(/\-/g, "")
    .replace(/\:/g, "")
    .replace(/\.\d+/, "");

// Adds some necesary headers and config, and signs the request
// by adding the `Authorization` header
export default function cleanAndSignS3(request, auth) {
  if (!request.method) request.method = "get";
  if (!request.headers) request.headers = {};
  if (request.method === "get" || request.method === "head") {
    delete request.body; // Get/Head requests have no body
  }

  // We don't want this that is added by Axios
  delete request.headers.Accept;

  request.headers.host = new URL(request.url).hostname;
  request.headers["x-amz-content-sha256"] = hash(request.body || "");
  request.headers["x-amz-date"] = request.headers["x-amz-date"] || plainDate();

  // Sort both query params and headers in alphabetic order
  request.params = sortValue(request.params || {});
  request.headers = sortValue(request.headers || {});

  request.headers.Authorization = createAuth(auth, request);

  return request;
}
