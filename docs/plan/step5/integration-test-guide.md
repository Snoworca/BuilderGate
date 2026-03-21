# Integration Test Guide

## Purpose

This guide defines the cross-stack verification required before Step 5 is considered releasable.

## Environment Baseline

- Build from the current working tree without touching unrelated local edits.
- Use a testable `server/config.json5` backup or fixture strategy before manual save scenarios.
- Start the backend and frontend with the standard local workflow.
- Log in with a known valid password before running settings tests.

## End-To-End Scenarios

### 1. Load Settings

- Open the app.
- Click the header settings button.
- Confirm the settings screen loads editable sections and hides secrets.

Expected result:

- current values load
- secret inputs are blank
- unsupported restart-required settings are absent

### 2. Change Session Duration

- Change `auth.durationMs`.
- Save.
- Log out and log back in.

Expected result:

- save succeeds
- later login token reflects the new duration
- existing authenticated session is not broken immediately

### 3. Change Password

- Enter current password, new password, and confirmation.
- Save.
- Attempt login with old password, then new password.

Expected result:

- old password fails
- new password succeeds
- plaintext password never appears in API responses

### 4. Enable 2FA

- Configure 2FA fields and SMTP password.
- Save.
- Log out and start a new login.

Expected result:

- login returns `requires2FA`
- OTP verification succeeds with the new configuration

### 5. Disable 2FA

- Disable 2FA.
- Save.
- Start a new login.

Expected result:

- login no longer requires OTP

### 6. Change PTY Defaults

- Update PTY shell or terminal size defaults.
- Save.
- Create a new session.

Expected result:

- new session uses the updated defaults
- existing sessions continue running

### 7. Change File Manager Rules

- Update blocked extensions, blocked paths, or directory limits.
- Save.
- Retry relevant file operations.

Expected result:

- later file operations reflect the new limits immediately

### 8. Change CORS Settings

- Update allowed origins or credential behavior.
- Save.
- Issue a later browser or preflight request from the changed origin profile.

Expected result:

- response headers match the updated runtime configuration

### 9. Invalid Save Rollback

- Submit an invalid combination such as incomplete 2FA enablement.

Expected result:

- save fails clearly
- UI draft remains
- runtime behavior and config file remain consistent

## Integration Matrix

| Area | Scenario Coverage |
| --- | --- |
| Auth | load, password rotation, token duration, 2FA enable or disable |
| Runtime config | PTY, session, file manager, CORS |
| Persistence | valid writes, invalid write rejection, backup creation |
| Frontend UX | header entry, dirty-state handling, save feedback |

## Evidence To Collect

- API responses for successful and failed saves
- before and after snapshots of relevant config sections
- screenshots of settings sections if manual QA is used
- logs for 2FA and runtime apply events
- notes on any fields downgraded from editable to excluded

## Pass Criteria

- All supported Step 5 settings can be loaded and saved from the UI.
- Runtime apply behavior matches documented scope.
- `config.json5` remains valid and operator-friendly.
- No unrelated functionality regresses.

## Failure Handling

- Record the failing field, payload, and runtime scope.
- Decide whether to fix the implementation or move the field to the excluded list.
- Re-run all affected scenarios after the correction.
