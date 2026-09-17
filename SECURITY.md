# Security Policy

## Supported Versions

infinite-canvas is in active development. Security fixes are accepted for the
`main` branch and the latest tagged release. Older versions may be handled on a
best-effort basis.

## Reporting a Vulnerability

Please do not open a public issue with exploit details, credentials, private
API keys, proof-of-concept code, or screenshots that reveal sensitive data.

Preferred reporting channels:

1. Use GitHub private vulnerability reporting or a GitHub Security Advisory for
   this repository, if available.
2. If a private GitHub report is not available, email `1844025705@qq.com` with
   the subject `[infinite-canvas security]`.
3. If neither private channel is available, open a public issue that asks for a
   private contact channel and does not include technical exploit details.

Please include:

- Affected version, commit, branch, or deployment mode.
- Clear reproduction steps.
- Impact and attack scenario.
- Any relevant logs, screenshots, or proof of concept, with secrets removed.
- Whether the issue affects public hosted deployments, session isolation,
  wallet and payment integrity, SSRF protection, or upstream credential handling.

## Scope

### Public platform architecture

The platform uses a Go backend (`server/`) that centrally manages upstream AI
credentials, user sessions, wallets, and asset storage (PostgreSQL and MinIO).
Upstream AI API keys are encrypted at rest and never delivered to client browsers.

Examples of in-scope reports:

- Credential exposure (e.g. leaking upstream `Authorization`, `x-api-key`, or `x-goog-api-key` headers via redirect, logs, or responses).
- Server-Side Request Forgery (SSRF) allowing access to local container networks or cloud metadata services.
- Authentication, session, or role bypass (e.g. privilege escalation to admin, session hijacking, or cross-account data access).
- Financial and wallet balance manipulation (e.g. race conditions in task settlement, payment callbacks, or balance deductions).
- Cross-Site Scripting (XSS) or cross-tenant data leakage in canvas projects or media storage.
- Unsafe file handling or object-storage path traversal.

Examples that are usually out of scope:

- Vulnerabilities in third-party AI upstreams or hosting infrastructures outside this repository.
- Denial-of-service reports that require unrealistic traffic volume or resource exhaustion beyond configured rate limits.
- Missing security headers without a demonstrated exploit path.
- Social engineering, phishing, or brute-force attacks against accounts with weak passwords.
- Dependency vulnerability reports without a proven exploitable path in this project.

## Disclosure

The maintainers aim to acknowledge valid reports within 7 days and coordinate a
fix before public disclosure. Response and fix timelines are best effort for
this community project.

Please allow time for investigation and remediation before publishing details.
Credit will be given on request unless you prefer to remain anonymous.

