# Agent Notes

## Dev/Test Ports

- HTTP redirect server: `http://localhost:2001`
- BuilderGate HTTPS server: `https://localhost:2002`
- Vite dev server: `http://localhost:2003`

## Validation Rule

- Manual validation and Playwright E2E must target `https://localhost:2002`.
- `http://localhost:2001` is the HTTP redirect port, not the frontend app port.
- `http://localhost:2003` is the Vite dev server port behind the HTTPS reverse proxy.
- Health check example: `curl -k https://localhost:2002/health`

## Password

- Local test password: `1234`

## Encoding Rule

- All file reads must assume `UTF-8` unless the user explicitly says otherwise.
- All file writes, rewrites, and generated files must use `UTF-8`.
- Do not use system-default code pages or locale-dependent encodings for project files.
