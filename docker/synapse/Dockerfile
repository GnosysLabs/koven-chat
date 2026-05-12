# Koven's Synapse — vanilla matrixdotorg/synapse plus our custom
# Python modules, installed into the system Python so Synapse can
# import them via `modules:` in homeserver.yaml.
#
# Modules:
#   - koven-room-gate: rate-limit + reputation-gate the publish-room-
#     to-directory action by delegating the decision to the engine.
#
# Note: the former koven-federation-gate module is gone — Koven
# instances no longer federate at all (homeserver.yaml drops the
# federation listener + sets an empty whitelist; nginx no longer
# serves /.well-known/matrix/server).  See docs/GOVERNANCE.md for
# the reasoning.

FROM matrixdotorg/synapse:latest

# Drop our modules into Synapse's Python environment.  The base image
# already has python3 / pip; we just install each package alongside
# Synapse's own dependencies.
COPY modules/koven-room-gate /tmp/koven-room-gate
RUN pip install --no-cache-dir /tmp/koven-room-gate \
 && rm -rf /tmp/koven-room-gate
