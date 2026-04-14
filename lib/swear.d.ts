declare module "swear" {
  function swear<T>(fn: () => Promise<T>): () => Promise<T>;
  export default swear;
}
