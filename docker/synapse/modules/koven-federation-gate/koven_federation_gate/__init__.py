"""
Koven federation gate — a Synapse module that allows federation only
with peers that prove they're running Koven.

The gate is dynamic: no operator action is required.  When Synapse
tries to talk to a remote homeserver for the first time, the module
fetches `https://<remote>/.well-known/koven`.  A valid Koven response
means the peer is fluent in our governance primitive (consensus
moderation, weighted reputation, public audit log) — those features
work end-to-end across the federation.  Anything else (404, malformed
JSON, vanilla Synapse) is denied.

Why dynamic instead of `federation_domain_whitelist`?
   The static whitelist is read once at startup, so adding a peer
   would require restarting Synapse.  That kills the UX of "user
   types @alice:other.koven.chat and it just works" — the first
   contact would either time out or require an admin reload.  This
   module replaces the whitelist with a runtime check + 10-minute
   cache, so first-contact pays one HTTPS probe and subsequent calls
   are cache hits.

Hookup:
   In homeserver.yaml:
     modules:
       - module: koven_federation_gate.KovenFederationGate
         config:
           # Optional — domains here are always allowed regardless
           # of the well-known probe.  Use for trusted peers that
           # don't (yet) host the discovery file.  Empty by default.
           always_allow: []
           # Optional — domains here are always denied even if
           # they advertise as Koven.  Empty by default.
           always_deny: []
"""

import json
import logging
import time
from typing import Any, Dict, List, Tuple

from twisted.web.client import Agent, readBody
from twisted.internet import reactor
from twisted.web.http_headers import Headers

logger = logging.getLogger(__name__)

# Cache time-to-live, in seconds.  Long enough that we don't probe
# every request, short enough that a peer flipping Koven status
# (rare but possible — e.g. they take Koven down for maintenance,
# or replace it with vanilla Synapse) recovers within minutes.
_ALLOW_TTL_SECONDS = 600       # 10 minutes for confirmed-allowed peers
_DENY_TTL_SECONDS = 60         # 1 minute for confirmed-denied (so a
                               # peer that just installed Koven flips
                               # over fast)
_PROBE_TIMEOUT_SECONDS = 5     # Per-probe network deadline


class KovenFederationGate:
    """
    Synapse spam-checker module that gates outbound federation by
    probing /.well-known/koven on each remote.
    """

    def __init__(self, config: Dict[str, Any], api):
        self._api = api
        self._always_allow = set(config.get("always_allow") or [])
        self._always_deny = set(config.get("always_deny") or [])
        # _cache: domain -> (allowed, expires_at_epoch_seconds)
        self._cache: Dict[str, Tuple[bool, float]] = {}
        # _in_flight: domain -> Deferred resolving to bool, so concurrent
        # federation requests to a fresh domain only fire one probe.
        self._in_flight: Dict[str, Any] = {}

        # Register the spam-checker callback.  This fires for every
        # event the server processes, including events arriving from
        # remote homeservers — letting us deny based on origin server.
        # A truthy return blocks the event with a 403.
        api.register_spam_checker_callbacks(
            check_event_for_spam=self._check_event_for_spam,
        )
        logger.info(
            "koven_federation_gate: loaded (always_allow=%s, always_deny=%s)",
            sorted(self._always_allow),
            sorted(self._always_deny),
        )

    # --- public hooks --------------------------------------------------

    async def _check_event_for_spam(self, event) -> "str | bool":
        """
        Called by Synapse on every event the local server sees.  We
        only care about events going out to / coming in from remote
        servers — local-only traffic is allowed unconditionally.

        Returns truthy ("not_koven") to deny, falsy to allow.
        """
        # event.sender is always populated; format is @user:server.
        sender_server = event.sender.split(":", 1)[1] if ":" in event.sender else None
        local_server = self._api.server_name

        # Local senders, local destinations: pass through.  Federation
        # only kicks in when the sender's server differs from ours.
        if not sender_server or sender_server == local_server:
            return False

        # Inbound from a remote — gate the source.
        allowed = await self._is_koven(sender_server)
        if not allowed:
            logger.info(
                "koven_federation_gate: rejecting event from %s — not a Koven peer",
                sender_server,
            )
            return "not_a_koven_peer"
        return False

    # --- core logic ----------------------------------------------------

    async def _is_koven(self, domain: str) -> bool:
        if domain in self._always_allow:
            return True
        if domain in self._always_deny:
            return False

        now = time.time()
        cached = self._cache.get(domain)
        if cached and cached[1] > now:
            return cached[0]

        # If a probe to this domain is already in-flight, reuse it
        # rather than firing a duplicate.  This matters during a sync
        # burst where many events from the same remote arrive at once.
        if domain in self._in_flight:
            return await self._in_flight[domain]

        deferred = self._probe(domain)
        self._in_flight[domain] = deferred
        try:
            allowed = await deferred
        finally:
            self._in_flight.pop(domain, None)

        ttl = _ALLOW_TTL_SECONDS if allowed else _DENY_TTL_SECONDS
        self._cache[domain] = (allowed, now + ttl)
        return allowed

    async def _probe(self, domain: str) -> bool:
        """
        Fetch https://<domain>/.well-known/koven.  Considered a Koven
        peer iff the response is HTTP 200 with JSON containing a
        non-empty "homeserver" string.  Any error or timeout = not
        Koven.
        """
        url = f"https://{domain}/.well-known/koven"
        try:
            agent = Agent(reactor, connectTimeout=_PROBE_TIMEOUT_SECONDS)
            response = await agent.request(
                b"GET",
                url.encode("ascii"),
                Headers({b"User-Agent": [b"koven-federation-gate"]}),
            )
            if response.code != 200:
                logger.debug(
                    "koven_federation_gate: %s probe -> HTTP %d (not Koven)",
                    domain, response.code,
                )
                return False
            body = await readBody(response)
            data = json.loads(body)
            if not isinstance(data, dict):
                return False
            homeserver = data.get("homeserver")
            return isinstance(homeserver, str) and len(homeserver) > 0
        except Exception as e:
            logger.debug(
                "koven_federation_gate: %s probe failed (%s) — treating as not Koven",
                domain, type(e).__name__,
            )
            return False
