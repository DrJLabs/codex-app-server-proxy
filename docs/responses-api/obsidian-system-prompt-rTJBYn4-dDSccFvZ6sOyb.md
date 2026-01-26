# Obsidian system prompt (req_id: rTJBYn4-dDSccFvZ6sOyb)

## Result
No system prompt was present in this request payload.

## Evidence
Ingress summary for `rTJBYn4-dDSccFvZ6sOyb`:
- `has_instructions: false`
- `input_item_types: ["message"]`
- `input_message_roles: ["developer", "user", "assistant"]`
- No `system` role observed

## Notes
Raw JSON-RPC payloads in `.codev/proto-events.ndjson` are redacted, so the full prompt text cannot be reconstructed from trace logs. To capture the exact system prompt, enable unredacted request capture (e.g., `PROXY_TRACE_REDACT=false` and `PROXY_CAPTURE_RESPONSES_RAW_TRANSCRIPTS=1`) and resend the request.
Unredacted capture can expose sensitive data; use only in controlled environments, limit access and duration, and revert the settings after debugging.
