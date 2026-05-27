"""Extension Worker Minimal Loop — Phase 3.

Simulates the full job lifecycle against the Control Plane Gateway
without touching a real provider (Gemini / Flow).  A real worker
replaces MockExecutor with a real provider driver but keeps the
same WorkerLoop + WorkerClient scaffold.
"""
