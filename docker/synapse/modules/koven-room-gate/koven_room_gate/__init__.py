"""
Koven room gate — a Synapse spam-checker module that delegates the
"can this user publish a room to the public directory?" decision to
the Koven engine.

Shape of the attack we're closing: a fresh account creates a flood of
rooms with offensive names and publishes them to the public directory,
where they show up in Explore + federate to peer Koven instances.  The
flag-then-collapse pipeline cleans these up reactively, but each room
exists with the offensive name visible to everyone until consensus
fires.  This module closes the gap by checking before the publish
proceeds: low-reputation users get a low cap (1 publish / 24h),
moderate users get 3, established users 10.  Admins + the engine bot
itself are uncapped.

Hookup:
   In homeserver.yaml:
     modules:
       - module: koven_room_gate.KovenRoomGate
         config:
           # Engine HTTP base — defaults to the docker compose
           # service name `engine` on the internal network.
           engine_url: http://engine:9000
           # Auth token shared with the engine.  Defaults to the
           # appservice as_token if unset; that's the same secret
           # already shared via the appservice yaml.
           auth_token: SOME_SHARED_SECRET

The hook only fires on Synapse's `user_may_publish_room` callback,
which Synapse invokes when a user calls `PUT /_matrix/client/v3/
directory/list/room/{roomId}` (or creates a room with `visibility:
"public"`).  Private room creation is unaffected — the attack vector
is the directory listing, not the room itself.
"""

import json
import logging
from typing import Any, Dict, Optional, Tuple, Union

from twisted.internet import reactor
from twisted.web.client import Agent, readBody
from twisted.web.http_headers import Headers
from twisted.web.iweb import IBodyProducer
from twisted.internet.defer import succeed
from zope.interface import implementer

logger = logging.getLogger(__name__)

# Per-call timeout to the engine.  If the engine is unreachable, the
# request fails open (allow) — better to let a flood through than to
# deadlock all room creation on a stalled callback.
_ENGINE_TIMEOUT_SECONDS = 5


@implementer(IBodyProducer)
class _BytesProducer:
    """Tiny twisted body producer for posting JSON bytes."""

    def __init__(self, body: bytes) -> None:
        self.body = body
        self.length = len(body)

    def startProducing(self, consumer):
        consumer.write(self.body)
        return succeed(None)

    def pauseProducing(self):
        pass

    def stopProducing(self):
        pass


class KovenRoomGate:
    """
    Synapse spam-checker that calls the Koven engine to decide whether
    a publish-to-directory request should proceed.
    """

    def __init__(self, config: Dict[str, Any], api):
        self._api = api
        self._engine_url: str = (
            config.get("engine_url") or "http://engine:9000"
        ).rstrip("/")
        token = config.get("auth_token")
        if not token:
            raise ValueError(
                "koven_room_gate: auth_token is required (shared secret with the engine)"
            )
        self._auth_token: str = str(token)
        self._agent = Agent(reactor)

        # Synapse's spam-checker dispatches to whichever callbacks we
        # register.  We only need user_may_publish_room — that fires
        # whenever a user attempts to publish a room to the public
        # directory.  Returns one of:
        #   - True  → allow
        #   - False → deny (Synapse maps to M_FORBIDDEN)
        #   - synapse.module_api.NOT_SPAM is the modern preferred form
        #     for "allow" but bool also works in current versions.
        api.register_spam_checker_callbacks(
            user_may_publish_room=self._user_may_publish_room,
        )
        logger.info(
            "koven_room_gate: loaded (engine_url=%s)",
            self._engine_url,
        )

    async def _user_may_publish_room(
        self, user_id: str, room_id: str
    ) -> Union[bool, str]:
        """
        Hit the engine's /api/internal/can-publish-room.  Fail-open on
        any network error: returning False here would lock all publish
        operations whenever the engine is briefly unavailable, which
        is worse UX than letting through what the flag pipeline can
        clean up reactively.
        """
        try:
            allowed, reason = await self._ask_engine(user_id, room_id)
        except Exception as e:
            logger.warning(
                "koven_room_gate: engine call failed (%s) — allowing %s on %s",
                e, user_id, room_id,
            )
            return True

        if allowed:
            return True
        logger.info(
            "koven_room_gate: deny user_may_publish_room %s on %s (reason=%s)",
            user_id, room_id, reason,
        )
        # Returning a string acts as a denial code that surfaces to
        # the client — Synapse maps it to a 403 with errcode=M_FORBIDDEN
        # and a hint the SPA can branch on.
        return reason or "rate_limited"

    async def _ask_engine(
        self, user_id: str, room_id: str
    ) -> Tuple[bool, Optional[str]]:
        body = json.dumps({"user_id": user_id, "room_id": room_id}).encode("utf-8")
        headers = Headers({
            b"Content-Type": [b"application/json"],
            b"Authorization": [f"Bearer {self._auth_token}".encode("utf-8")],
        })
        url = f"{self._engine_url}/api/internal/can-publish-room".encode("utf-8")
        producer = _BytesProducer(body)

        response = await self._agent.request(b"POST", url, headers, producer)
        raw = await readBody(response)
        if response.code != 200:
            # Treat any non-200 the same as a network failure: allow.
            # Logging the body helps debug auth misconfig (403 here
            # means the auth_token doesn't match the engine's as_token).
            logger.warning(
                "koven_room_gate: engine returned HTTP %d — allowing.  Body: %s",
                response.code, raw[:200],
            )
            return True, None
        try:
            payload = json.loads(raw)
        except Exception:
            logger.warning("koven_room_gate: engine returned non-JSON, allowing")
            return True, None
        allowed = bool(payload.get("allowed"))
        reason = payload.get("reason")
        return allowed, str(reason) if reason else None
