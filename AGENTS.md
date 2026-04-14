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
