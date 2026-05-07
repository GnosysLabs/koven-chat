# Koven's Synapse — vanilla matrixdotorg/synapse plus our federation
# gate Python module installed into the system Python so Synapse can
# import it via `modules:` in homeserver.yaml.

FROM matrixdotorg/synapse:latest

# Drop our module into Synapse's Python environment.  The base image
# already has python3 / pip; we just install our package alongside
# Synapse's own dependencies.
COPY modules/koven-federation-gate /tmp/koven-federation-gate
RUN pip install --no-cache-dir /tmp/koven-federation-gate \
 && rm -rf /tmp/koven-federation-gate
