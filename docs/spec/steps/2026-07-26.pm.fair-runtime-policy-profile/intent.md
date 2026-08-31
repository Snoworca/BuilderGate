# Intent: 2026-07-26.pm.fair-runtime-policy-profile

Correct the fair-scheduler evidence path after the live runtime correctly fail-closed on a policy-hash mismatch. The benchmark and official publisher will measure the effective RuntimeConfigStore WS policy, bind it through the existing TerminalResourcePolicy resolver, and prove live WSS admission before the AC-6 invalid-ACK probe.

Requirement: PERF-BGSTAB-010 (AC-2, AC-3, AC-4, AC-6 prerequisite).
