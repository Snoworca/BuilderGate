# Phase 3 Verification Template

## Completion Checklist

- [ ] `WsRouter` sends `history`
- [ ] replay barrier and `history:ready` flow exist
- [ ] frontend handles `history`
- [ ] terminal clear-and-replay path exists
- [ ] local snapshot path is demoted or bypassed

## Quality Checks

- Duplicate-replay target: none in refresh and reconnect tests
- Console-error target: no xterm restore exceptions
- Ordering target: history applied before buffered live output flush

## Approval Gate

- [ ] WebSocket reviewer signs off
- [ ] terminal replay reviewer signs off
