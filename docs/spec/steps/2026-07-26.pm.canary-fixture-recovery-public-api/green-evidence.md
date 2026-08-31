# Public fixture GREEN evidence

The public fixture Green implementation is test-support only. It is not
evidence that a parent fair-delivery acceptance criterion is complete.

| Check | Result |
|---|---|
| `npx.cmd --no-install tsx --test src/services/TerminalResourcePolicyCanaryPublicFixture.test.ts` | pass 1 / fail 0 |
| `npx.cmd --no-install tsx --test src/services/SessionManager.test.ts` | pass 1 / fail 0 (independent run) |
| `npx.cmd --no-install tsx --test src/services/TerminalResourcePolicyCanary.test.ts` | pass 24 / fail 0 (independent run; existing untracked monolith) |
| `npx.cmd --no-install tsc --noEmit --pretty false` | no fixture error; only four pre-existing TS18048 diagnostics in the untracked Canary monolith |
| Independent public-fixture review | No findings after AC-6 corrective review |

The preserved Canary monolith remained untracked with SHA-256
`8b7aa040151487d283052ad980c5337e2ad62c6c4a60f2a19fb80cd16db4ff06`.
