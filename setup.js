import "isomorphic-fetch";

import expect from "expect";

global.FormData = class FormData {};

expect.extend({
  toHaveMethod(obj, key) {
    if (!obj) {
      return {
        pass: false,
        message: () => `Expected ${obj} to be defined`,
      };
    }
    if (!obj[key]) {
      return {
        pass: false,
        message: () => `Expected "${obj.name || obj}" to have method ${key}()`,
      };
    }
    if (typeof obj[key] !== "function") {
      return {
        pass: false,
        message: () => `Expected ${obj}.${key} to be a function`,
      };
    }

    return {
      pass: true,
      message: () => `Expected ${obj} to not be a method`,
    };
  },
});
