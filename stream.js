import BackblazeBucket from "./b2/index.js";

const b2 = BackblazeBucket();

console.log(await b2.list({ limit: 4 }));
