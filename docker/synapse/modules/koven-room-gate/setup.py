"""Pip-install metadata for koven_room_gate.

The module is loaded by Synapse via `modules:` in homeserver.yaml.  It
needs to be importable from Synapse's Python environment, which we
arrange by `pip install`ing this package into the Synapse Docker image
at build time (see ../Dockerfile).
"""
from setuptools import setup, find_packages

setup(
    name="koven-room-gate",
    version="0.1.0",
    description="Synapse module: rate-limit + reputation-gate public-room publishing.",
    packages=find_packages(),
    python_requires=">=3.8",
)
