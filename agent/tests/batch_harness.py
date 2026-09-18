"""Test harness for Flow's batchexecute transport.

Lives outside conftest on purpose: conftest is for fixtures, and these are
plain helpers several test modules import by name.
"""
from __future__ import annotations

import json

from flowboard.services.flow_sdk import (
    IMAGE_UI_SUBMIT_OFFSETS_S as PRODUCTION_IMAGE_OFFSETS,
)

#: The real submit cadence, bound at import time — i.e. at collection, before
#: any fixture runs. The suite patches the module attribute to zeros so tests
#: don't wait on it, and reading `flow_sdk.IMAGE_UI_SUBMIT_OFFSETS_S` (or the
#: module __dict__, which is the same namespace) would therefore see the zeros.
#: Tuples are immutable, so this binding cannot be patched out from under us.

# ── batchexecute test harness ──────────────────────────────────────────────
#
# Flow's transport is now a single batchexecute endpoint that the extension
# POSTs from inside the Flow page, so the SDK's whole observable output is the
# `f.req` envelope it hands to `flow_client.batch_rpc`. These helpers decode
# that envelope, which is the only place the wire-level traps can be caught —
# asserting on the SDK's return value alone would happily pass while the
# aspect ratio sat in the variant-count slot.

def batch_envelope(rpcid: str, payload) -> str:
    """Build a batchexecute RESPONSE body carrying ``payload`` for ``rpcid``.

    Mirrors what the page hands back: a ``)]}'`` sentinel, then chunks of
    ``["wrb.fr", rpcid, "<payload as a JSON string>", ...]``. The real thing
    prefixes each chunk with a character count; the parser scans instead of
    trusting it, so the count is omitted here.
    """
    inner = json.dumps(payload, separators=(",", ":"))
    chunk = json.dumps(
        [["wrb.fr", rpcid, inner, None, None, None, "generic"]],
        separators=(",", ":"),
    )
    return ")]}'\n\n" + str(len(chunk)) + "\n" + chunk


def batch_error_envelope(rpcid: str, code=None) -> str:
    """A response whose payload slot is null — the RPC's error shape."""
    chunk = json.dumps(
        [["wrb.fr", rpcid, None, None, None, code or [8], "generic"]],
        separators=(",", ":"),
    )
    return ")]}'\n\n" + str(len(chunk)) + "\n" + chunk


def decode_freq(freq: str):
    """Reverse of ``flow_batch.build_envelope``: the inner payload of a request."""
    return json.loads(json.loads(freq)[0][0][1])


class BatchRecorder:
    """A fake ``FlowClient`` that records ``batch_rpc`` calls.

    ``responses`` maps an rpcid to either one body or a list of bodies
    consumed in order, which is how a multi-round poll gets scripted. An rpcid
    with no entry falls through to ``default``; if that is None the call raises,
    so a test can never silently pass by exercising an RPC it forgot to stub.
    """

    def __init__(self, responses=None, default=None) -> None:
        self.calls: list[dict] = []
        self.responses: dict = dict(responses or {})
        self.default = default

    async def batch_rpc(self, rpcid, freq, captcha_action=None,
                        match=None, timeout=None):
        self.calls.append({
            "rpcid": rpcid, "freq": freq, "captcha_action": captcha_action,
            "match": match, "timeout": timeout,
        })
        if rpcid in self.responses:
            scripted = self.responses[rpcid]
            if isinstance(scripted, list):
                if not scripted:
                    raise AssertionError(f"ran out of scripted {rpcid} responses")
                scripted = scripted.pop(0)
            if isinstance(scripted, dict):      # a raw bridge result
                return scripted
            return {"status": 200, "data": scripted}
        if self.default is None:
            raise AssertionError(
                f"unstubbed batch_rpc for {rpcid!r} — add it to responses"
            )
        return {"status": 200, "data": self.default}

    # ── assertions helpers ────────────────────────────────────────────────
    def rpcs(self, rpcid: str) -> list[dict]:
        return [c for c in self.calls if c["rpcid"] == rpcid]

    def payload(self, rpcid: str, index: int = 0):
        """The decoded inner payload of the index-th request for ``rpcid``."""
        calls = self.rpcs(rpcid)
        assert calls, f"no {rpcid} call was recorded (saw {[c['rpcid'] for c in self.calls]})"
        return decode_freq(calls[index]["freq"])


# ── request-item slot indices ─────────────────────────────────────────────
#
# flow_batch speaks Flow's positional arrays, so a test that asserts on the
# wire has to index into them. The slots are named here so the magic numbers
# live in one place, and so the two aspect encodings that are easy to confuse
# stay visible: for an IMAGE 1 is square, 2 portrait, 3 landscape; for a VIDEO
# 1 is portrait and 2 is landscape.

#: Image request item:
#: [_, _, imageInputs, seed, aspect, model, _, context, prompt, ...]
IMG_INPUTS, IMG_SEED, IMG_ASPECT, IMG_MODEL = 2, 3, 4, 5

#: One image input: [mediaId, _, _, _, inputType]
INPUT_TYPE = 4

#: Veo i2v request item:
#: [promptBlock, model, aspect, _, sourceBlock, clientIds]
VID_MODEL, VID_ASPECT, VID_SOURCE = 1, 2, 4
#: ...and inside sourceBlock: [_, mediaId, _, _, _, crop]
SRC_MEDIA_ID = 1

#: Omni reference-to-video item:
#: [promptBlock, references, model, aspect, _, clientIds]
OMNI_REFS, OMNI_MODEL, OMNI_ASPECT = 1, 2, 3


def image_items(payload):
    """The request items out of an ogiZ0b payload: [_, items, 1, context, _]."""
    return payload[1]


def video_item(payload):
    """The single request item out of an eb1hJf / MZZa6b payload."""
    return payload[0][0]


def operation_payload(operation_id, project_id="proj-1", status=None, detail=None):
    """An operation record as jwpduf and the video submits return it.

    ``[_, _, [[opId, projectId, sceneId, status, _, detail]]]`` — note the
    third uuid is the SCENE, not the media. Feeding it to the media rpc
    answers NOT_FOUND forever; the media id lives only in the project listing.
    """
    record = [operation_id, project_id, "11111111-2222-3333-4444-555555555555",
              status, None, detail]
    return [None, 50, [record]]


def complaint_detail(message="Media not found."):
    """The detail block shape that carries a poll complaint (outcome code 4).

    Survivable by design: operations report this and still deliver a finished
    clip, so the SDK must treat it as a diagnostic, never as a verdict.
    """
    return [None, None, None, None, None, None, None, None,
            [4, [None, message], [message]]]


def media_urls_payload(media_id, video=True, image=True):
    """An as29s payload carrying signed urls for ``media_id``.

    The poster image appears before the video does — downloading on the media
    id alone saves a still picture, so a video url is the only proof a clip is
    fetchable.
    """
    urls = []
    if image:
        urls.append(f"https://flow-content.google/image/{media_id}?sig=poster")
    if video:
        urls.append(f"https://flow-content.google/video/{media_id}?sig=clip")
    return [urls]


def listing_payload_text(operation_id, media_id):
    """The 800-byte window the extension returns from the project listing.

    Entries look like
    ``[opId, null, null, [title, created, null, null, mediaId, ...], projectId]``
    and the SDK scans the raw text for them, because the full listing outgrows
    any response cap.
    """
    return (
        f'["{operation_id}",null,null,["a title",1234,null,null,'
        f'"{media_id}","client-uuid",true],"proj-1"]'
    )


def image_recorder(count=1, media_prefix="img"):
    """A recorder that answers ``count`` image RPCs with one url each."""
    from flowboard.services import flow_batch as fb
    return BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [
            batch_envelope(
                fb.RPC_GEN_IMAGE,
                [[f"https://flow-content.google/image/{media_prefix}-{i}?sig=x"]],
            )
            for i in range(count)
        ],
    })
