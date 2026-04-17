# Phase 2 Verification Template

## Completion Checklist

- [ ] replay append always runs on PTY output
- [ ] safe truncation helper exists
- [ ] replay snapshot API exists
- [ ] runtime cap reduction re-truncates existing replay buffers
- [ ] server tests cover truncation and non-clearing semantics

## Quality Checks

- Buffer boundedness target: never exceed configured cap
- Escape-boundary safety target: no broken replay prefix
- Filter explicitness target: policy documented and test-backed

## Approval Gate

- [ ] Session manager reviewer signs off
- [ ] test coverage reviewer signs off
