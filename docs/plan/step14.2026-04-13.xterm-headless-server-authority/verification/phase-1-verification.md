# Phase 1 Verification

## Completion Checklist

- [ ] headless dependency path is added
- [ ] Node-side serialization is proven
- [ ] resize serialization is proven
- [ ] alt-screen serialization is proven
- [ ] protocol names and replay token contract are frozen

## Test Evidence Required

- [ ] deterministic server test for normal-screen serialization
- [ ] deterministic server test for resize
- [ ] deterministic server test for alt-screen

## Quality Gate

- [ ] serialization path works in the real server runtime
- [ ] no unresolved contract ambiguity remains
- [ ] Phase 2 is blocked if alt-screen or resize quality is unacceptable
