# Contributing

## Code examples in docs

Examples show the patterns we want users to copy (ignore comments):

````md
## helper()

One short sentence saying what it does:

\```ts
// A ref-like pseudo code, ignoring details
await bucket.list();
await bucket.list(/filter/);
\```

One or two paragraphs with a more general description

\```ts
// A longer, more realistic example
const files = await bucket.list();
files.map((file: BucketFile) => {
...
});
\```

[section(note 1)]
Some thing that is important to note

\```ts
// A code example demostrating that important thing to note
???
````

[/section]

[section 2, 3, etc]

### Examples

Example 1

Example 2

### Related methods

- .scan(regex)

## Testing

```bash
bun test                 # mocked suites, signer oracles, FileSystem (no network)
EXPENSIVE=true bun test  # also the cloud providers, when credentials are present
```

The test suite has three layers, the first two of which need **no credentials**:

1. **Mocked unit tests** (`*/index.test.ts`): exercise each provider's request/response handling with a stubbed `fetch`.
2. **Signer oracle tests** (`lib/*.test.ts`): prove the request signing is correct without hitting any service:
   - S3/R2 AWS Signature V4 is cross-checked against [`aws4`](https://www.npmjs.com/package/aws4) (the reference signer): identical signature, byte for byte.
   - GCS V4 signatures are verified cryptographically against the public key.
3. **Integration tests** (`test/index.test.ts`): the full API against a real backend. FileSystem always runs; the cloud providers (S3, R2, GCS, Azure, B2) are opt-in and run only with `EXPENSIVE=true` set, plus their credentials (or an emulator endpoint). A plain `bun test` stays local and makes no network calls.

### Emulators

S3, R2, GCS and Azure can be tested end-to-end against local emulators, no Docker required. MinIO and Azurite **validate request signatures**, so a green run proves the signer against a real server.

The emulators run as native binaries. Azurite ships as a devDependency (installed by `bun install`); MinIO (S3 + R2) and fake-gcs-server (GCS) are standalone binaries that need to be on your `PATH`:

```bash
brew install minio fake-gcs-server   # macOS; see each project's docs for other OSes
```

Then a single command starts all three, seeds the buckets, runs the suite, and tears everything down:

```bash
npm run test:emulators
```

Configuration lives in [`.env.emulators`](.env.emulators) (well-known emulator defaults, no secrets). To run against one provider only, start the emulators yourself and filter with `BUCKET`:

```bash
npx azurite-blob --silent --location /tmp/azurite &
bun run emulators:setup
BUCKET=Azure bun --env-file=.env.emulators test test/index.test.ts
```

### Real credentials

Copy `.env.sample` to `.env` and fill in the providers you want to exercise, then opt in with `EXPENSIVE=true`; the buckets whose credentials are present are picked up automatically.

```bash
EXPENSIVE=true bun test
```
