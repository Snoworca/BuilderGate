# Intent: 2026-07-27.pm.fair-readmission-closure-v3-fd-manifest

Harden the private manifest write transaction with a retained exclusive-create descriptor. The
created leaf's identity is observed from its descriptor rather than from a mutable pathname,
while existing public admission and opaque-wave boundaries remain closed.
