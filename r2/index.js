import "dotenv/config";

import fch from "fch";
import xml from "xml-js";

import cleanAndSignS3 from "../lib/cleanAndSignS3";

const {
  CLOUDFLARE_URL: URI,
  CLOUDFLARE_ID: ID,
  CLOUDFLARE_KEY: KEY,
  CLOUDFLARE_REGION: REGION,
} = process.env;

function request(config) {
  // Calculate the authorization
  cleanAndSignS3(config, config.s3config);

  return fetch(config.url, config);
}

// Based on https://github.com/nashwaan/xml-js/issues/53
function parseResponse(res) {
  function nativeType(value) {
    var nValue = Number(value);
    if (!isNaN(nValue)) {
      return nValue;
    }
    var bValue = value.toLowerCase();
    if (bValue === "true") {
      return true;
    } else if (bValue === "false") {
      return false;
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    }
    return value;
  }

  var removeJsonTextAttribute = function (value, parentElement) {
    try {
      var keyNo = Object.keys(parentElement._parent).length;
      var keyName = Object.keys(parentElement._parent)[keyNo - 1];
      parentElement._parent[keyName] = nativeType(value);
    } catch (e) {}
  };

  var options = {
    compact: true,
    ignoreDeclaration: true,
    ignoreInstruction: true,
    ignoreAttributes: true,
    ignoreComment: true,
    ignoreCdata: true,
    ignoreDoctype: true,
    textFn: removeJsonTextAttribute,
  };

  res.body = JSON.parse(xml.xml2json(res.data || res.body, options));
  return res;
}

export default function (baseURL = URI, s3config = {}) {
  if (!s3config.id) s3config.id = ID;
  if (!s3config.key) s3config.key = KEY;
  if (!s3config.region) s3config.region = REGION || "us-east-1";

  const api = fch.create({
    baseURL,
    before: (req) => cleanAndSignS3(req, s3config),
    after: parseResponse,
  });

  async function list() {
    const data = await api.get("");
    let content = data.ListBucketResult.Contents;
    return content.map((item) => ({
      id: item.ETag,
      name: item.Key.split("/").pop(),
      path: "/" + item.Key.replace(/^\//, ""),
      type: item.Key.split(".").pop(),
      size: item.Size,
      date: new Date(item.LastModified),
    }));
  }

  async function exists(file) {
    // Avoid throwing on 404, since it IS expected in this case
    const res = await api.head(file, { error: (e) => e }).raw();
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error("Error Status " + res.status);
  }

  return { list, exists };
}
