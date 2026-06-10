# Auth email rollout

This rollout switches Supabase Auth off the default mailer and onto Resend.

## Scope

- verify `auth.flowboard.bond` on Resend
- use `Flowboard <no-reply@auth.flowboard.bond>` as the sender
- keep `site_url` pointed at `https://app.flowboard.bond`
- keep redirect allowlist open for production, Pages previews, and local dev
- raise auth email rate limits to a test-friendly level

## Production settings

- SMTP host: `smtp.resend.com`
- SMTP port: `465`
- SMTP user: `resend`
- sender: `no-reply@auth.flowboard.bond`
- sender name: `Flowboard`

## DNS records

- `TXT resend._domainkey.auth`
- `MX send.auth -> feedback-smtp.ap-northeast-1.amazonses.com`
- `TXT send.auth -> v=spf1 include:amazonses.com ~all`

## Notes

- signup confirmation redirects back to `https://app.flowboard.bond/?auth=confirmed`
- password recovery redirects back to the current app origin
- `rate_limit_email_sent` is set to `30` for beta testing
