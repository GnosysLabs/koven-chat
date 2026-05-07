# Koven's Synapse — vanilla matrixdotorg/synapse plus our custom
# Python modules, installed into the system Python so Synapse can
# import them via `modules:` in homeserver.yaml.
#
# Modules:
#   - koven-federation-gate: dynamic Koven-only federation via a
#     /.well-known/koven probe.
#   - koven-room-gate: rate-limit + reputation-gate the publish-room-
#     to-directory action by delegating the decision to the engine.

FROM matrixdotorg/synapse:latest

# Drop our modules into Synapse's Python environment.  The base image
# already has python3 / pip; we just install each package alongside
# Synapse's own dependencies.
COPY modules/koven-federation-gate /tmp/koven-federation-gate
COPY modules/koven-room-gate       /tmp/koven-room-gate
RUN pip install --no-cache-dir /tmp/koven-federation-gate /tmp/koven-room-gate \
 && rm -rf /tmp/koven-federation-gate /tmp/koven-room-gate
