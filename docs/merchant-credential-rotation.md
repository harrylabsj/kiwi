# Kiwi merchant credential rotation

Kiwi keeps the shopping-cli merchant credential in
`~/.kiwi/credentials.env` as `SHOPPING_MERCHANT_TOKEN`. The Kiwi Catalog
credential `KIWI_MERCHANT_TOKEN` remains separate and is not changed by this
workflow.

Run `kiwi merchant credentials rotate --profile <merchant.yaml>` to start a
rotation. Kiwi stages the old and new shopping-cli credentials plus the
rotation id in a mode `0600` recovery sidecar before making a request. It uses
HTTPS for remote shopping-cli APIs and permits HTTP only for loopback. The new
credential is verified against the merchant private-config endpoint before
Kiwi stops the existing managed A2A/MCP processes. Kiwi then atomically updates
the credential file, starts the same managed processes with the new environment
value, and waits for the A2A child itself to call that protected endpoint and
receive a response for the expected merchant. Kiwi checks that the child proof
PID matches the running managed A2A PID before it confirms the server rotation
with the new token. The old token stays valid until that confirmation.

If the command exits with a pending sidecar, run
`kiwi merchant credentials recover --profile <merchant.yaml>`. The sidecar
retains the exact rotation id and both credentials, so a lost prepare response
can be retried and an ambiguous confirm response can be settled idempotently.
Kiwi does not infer that the old token is still valid after a 401/403; it probes
the old token explicitly before starting a replacement rotation. If neither
credential authenticates, the sidecar remains for admin recovery and the
command fails closed.

When `kiwi merchant runtime start` is supervising the merchant, it checks the
protected token status every five minutes and begins rotation up to seven days
before expiry. The lead window is capped at one fifth of the token lifetime to
avoid repeatedly rotating newly issued credentials. Override
the polling interval with `KIWI_MERCHANT_TOKEN_ROTATION_POLL_SECONDS` (60–300)
and the lead time with `KIWI_MERCHANT_TOKEN_ROTATE_BEFORE_SECONDS` (1 hour–30
days). Automatic rotation is enabled only when the profile's shopping token is
separate from the Catalog token and is present in the private credentials file.
The scheduler queries the authenticated token-status API for expiry; it does
not infer dates from local token contents. If the A2A child is down, a status
request fails, or the child cannot prove the new token, the scheduler records a
safe error code, logs a warning, keeps the old token valid and leaves recovery
state when a rotation has begun.

Run `kiwi merchant doctor --profile <merchant.yaml>` to inspect credential
separation, file permissions, protected expiry status, recovery markers, and
whether the runtime scheduler is active. The command does not change files or
credentials. It also checks local enrollment state, signing-key readability
and local thumbprint consistency, plus the last accepted signed-heartbeat
receipt. The report labels live Catalog binding availability as `unknown`
because those local records do not prove the current remote state.

The sidecar is removed only after server confirmation and successful restart of
the previously running managed services. If restart fails after confirmation,
the sidecar remains so recovery can retry the process switch. Kiwi does not
print token values.
