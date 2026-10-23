#!/bin/sh
# Shim so the bridge can spawn the fake agent as a real binary.
exec node "$(dirname "$0")/fake-agent.mjs" "$@"