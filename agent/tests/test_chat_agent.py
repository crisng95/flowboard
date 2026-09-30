"""chat_agent ReAct loop — scripted LLM, mocked media.

``run_llm`` is scripted per test; ``run_muse_media`` is mocked (no Muse
worker needed). ``record_activity`` runs for real (Request rows).
"""
import asyncio
import json
from unittest.mock import AsyncMock, patch

from flowboard.db import get_session
from flowboard.db.models import Asset, Board, ChatMessage, ChatRun, Edge, Node
from flowboard.services import chat_agent
from flowboard.services.llm.base import LLMError


def _mk_run(board_name="T", message="do it"):
    with get_session() as s:
        b = Board(name=board_name)
        s.add(b)
        s.commit()
        s.refresh(b)
        m = ChatMessage(board_id=b.id, role="user", content=message, mentions=[])
        s.add(m)
        s.commit()
        s.refresh(m)
        run = ChatRun(board_id=b.id, user_message_id=m.id, status="running")
        s.add(run)
        s.commit()
        s.refresh(run)
        return b.id, run.id


def _short_ids(board_id):
    with get_session() as s:
        from sqlmodel import select

        nodes = s.exec(
            select(Node).where(Node.board_id == board_id).order_by(Node.id)
        ).all()
        return [n.short_id for n in nodes]


def _run_row(run_id):
    with get_session() as s:
        return s.get(ChatRun, run_id)


def _assistant_messages(board_id):
    with get_session() as s:
        from sqlmodel import select

        return s.exec(
            select(ChatMessage).where(
                ChatMessage.board_id == board_id,
                ChatMessage.role == "assistant",
            )
        ).all()


def test_full_scripted_run_create_edge_gen_image():
    board_id, run_id = _mk_run()

    plan = [
        lambda: json.dumps(
            {"tool": "create_node",
             "args": {"type": "image", "x": 0, "y": 0, "data": {"prompt": "cat"}}}
        ),
        lambda: json.dumps(
            {"tool": "create_node", "args": {"type": "video"}}
        ),
        lambda: json.dumps(
            {
                "tool": "add_edge",
                "args": {
                    "from_short_id": _short_ids(board_id)[0],
                    "to_short_id": _short_ids(board_id)[1],
                    "kind": "ref",
                },
            }
        ),
        lambda: json.dumps(
            {
                "tool": "gen_image",
                "args": {
                    "prompt": "a red cat",
                    "node_short_id": _short_ids(board_id)[0],
                },
            }
        ),
        lambda: json.dumps({"done": True, "reply": "xong"}),
    ]

    async def fake_llm(*args, **kwargs):
        return plan.pop(0)()

    async def fake_media(**kwargs):
        assert kwargs["kind"] == "image"
        assert kwargs["prompt"] == "a red cat"
        return {"media_ids": ["mid_cat"], "media_entries": []}, None

    with (
        patch.object(chat_agent, "run_llm", fake_llm),
        patch.object(chat_agent, "run_muse_media", fake_media),
    ):
        asyncio.run(
            chat_agent.run_chat_agent(board_id, run_id, "do it", [], [])
        )

    assert plan == []
    shorts = _short_ids(board_id)
    assert len(shorts) == 2

    with get_session() as s:
        from sqlmodel import select

        img = s.exec(
            select(Node).where(Node.short_id == shorts[0])
        ).first()
        assert img.data["mediaIds"] == ["mid_cat"]
        assert img.data["mediaId"] == "mid_cat"
        assert img.status == "done"
        edges = s.exec(select(Edge).where(Edge.board_id == board_id)).all()
        assert len(edges) == 1
        # activity rows: one per turn (4 tool turns)
        from flowboard.db.models import Request

        reqs = s.exec(
            select(Request).where(Request.type == "chat_agent")
        ).all()
        assert len(reqs) == 4
        assert all(r.status == "done" for r in reqs)

    run = _run_row(run_id)
    assert run.status == "done"
    msgs = _assistant_messages(board_id)
    assert len(msgs) == 1 and msgs[0].content == "xong"


def test_gen_video_binds_to_new_video_node():
    board_id, run_id = _mk_run()
    with get_session() as s:
        a = Asset(
            kind="image",
            uuid_media_id="srcmid1",
            local_path="/tmp/frame.png",
            mime="image/png",
        )
        s.add(a)
        s.commit()
        s.refresh(a)
        aid = a.id

    async def fake_llm(*args, **kwargs):
        calls = getattr(fake_llm, "n", 0)
        fake_llm.n = calls + 1
        if calls == 0:
            return json.dumps(
                {
                    "tool": "gen_video",
                    "args": {"prompt": "slow push-in", "source_asset_id": aid},
                }
            )
        return json.dumps({"done": True, "reply": "video xong"})

    seen = {}

    async def fake_media(**kwargs):
        seen.update(kwargs)
        return {"media_ids": ["vid1"], "media_entries": []}, None

    with (
        patch.object(chat_agent, "run_llm", fake_llm),
        patch.object(chat_agent, "run_muse_media", fake_media),
    ):
        asyncio.run(chat_agent.run_chat_agent(board_id, run_id, "do it", [], []))

    assert seen["kind"] == "video"
    assert seen["source_media_ids"] == ["srcmid1"]
    with get_session() as s:
        from sqlmodel import select

        vids = s.exec(
            select(Node).where(Node.board_id == board_id, Node.type == "video")
        ).all()
        assert len(vids) == 1
        assert vids[0].data["mediaIds"] == ["vid1"]
    assert _run_row(run_id).status == "done"


def test_concat_videos_creates_merge_node(monkeypatch):
    board_id, run_id = _mk_run()
    with get_session() as s:
        vids = [
            Asset(kind="video", uuid_media_id=f"cvmid{i}",
                  local_path=f"/tmp/v{i}.mp4", mime="video/mp4")
            for i in range(2)
        ]
        s.add_all(vids)
        s.commit()
        for v in vids:
            s.refresh(v)
        aids = [v.id for v in vids]
        out = Asset(kind="video", uuid_media_id="concatmid",
                    local_path="/tmp/out.mp4", mime="video/mp4")
        s.add(out)
        s.commit()
        s.refresh(out)
        out_id = out.id

    monkeypatch.setattr(
        "flowboard.services.video_concat.concat_video_assets",
        lambda ids: (out_id, None),
    )

    async def fake_llm(*args, **kwargs):
        calls = getattr(fake_llm, "n", 0)
        fake_llm.n = calls + 1
        if calls == 0:
            return json.dumps(
                {"tool": "concat_videos",
                 "args": {"video_asset_ids": aids}}
            )
        return json.dumps({"done": True, "reply": "ghép xong"})

    async def fake_media(**kwargs):  # pragma: no cover — not used here
        raise AssertionError("should not be called")

    with (
        patch.object(chat_agent, "run_llm", fake_llm),
        patch.object(chat_agent, "run_muse_media", fake_media),
    ):
        asyncio.run(chat_agent.run_chat_agent(board_id, run_id, "do it", [], []))

    with get_session() as s:
        from sqlmodel import select

        merges = s.exec(
            select(Node).where(Node.board_id == board_id, Node.type == "merge")
        ).all()
        assert len(merges) == 1
        assert merges[0].data["mediaIds"] == ["concatmid"]
    assert _run_row(run_id).status == "done"


def test_llm_error_fails_run_with_message():
    board_id, run_id = _mk_run()

    async def boom(*args, **kwargs):
        raise LLMError("boom")

    with patch.object(chat_agent, "run_llm", boom):
        asyncio.run(chat_agent.run_chat_agent(board_id, run_id, "do it", [], []))

    run = _run_row(run_id)
    assert run.status == "failed"
    msgs = _assistant_messages(board_id)
    assert len(msgs) == 1 and "boom" in msgs[0].content


def test_unparseable_and_unknown_tool_recover():
    board_id, run_id = _mk_run()
    script = [
        "this is not json at all",
        json.dumps({"tool": "nope", "args": {}}),
        json.dumps({"done": True, "reply": "recovered"}),
    ]

    async def fake_llm(*args, **kwargs):
        return script.pop(0)

    with patch.object(chat_agent, "run_llm", fake_llm):
        asyncio.run(chat_agent.run_chat_agent(board_id, run_id, "do it", [], []))

    assert script == []
    assert _run_row(run_id).status == "done"
    msgs = _assistant_messages(board_id)
    assert msgs[0].content == "recovered"


def test_update_node_and_refresh_tools():
    board_id, run_id = _mk_run()
    script = [
        json.dumps(
            {"tool": "create_node",
             "args": {"type": "note", "data": {"title": "draft"}}}
        ),
        lambda: json.dumps(
            {
                "tool": "update_node",
                "args": {
                    "short_id": _short_ids(board_id)[0],
                    "data_patch": {"title": "final", "gone": None},
                },
            }
        ),
        lambda: json.dumps({"tool": "refresh", "args": {}}),
        lambda: json.dumps({"done": True, "reply": "ok"}),
    ]

    async def fake_llm(*args, **kwargs):
        step = script.pop(0)
        return step() if callable(step) else step

    with patch.object(chat_agent, "run_llm", fake_llm):
        asyncio.run(chat_agent.run_chat_agent(board_id, run_id, "do it", [], []))

    with get_session() as s:
        from sqlmodel import select

        node = s.exec(select(Node).where(Node.board_id == board_id)).first()
        assert node.data["title"] == "final"
        assert "gone" not in node.data
    assert _run_row(run_id).status == "done"


def test_build_board_context_includes_history_and_nodes():
    board_id, run_id = _mk_run(message="first")
    with get_session() as s:
        s.add(
            ChatMessage(
                board_id=board_id, role="assistant",
                content="previous reply", mentions=[],
            )
        )
        s.add(
            Node(board_id=board_id, short_id="ab12", type="image",
                 data={"prompt": "a cat", "mediaIds": ["m1", "m2"]})
        )
        s.commit()
    ctx = chat_agent.build_board_context(board_id, "second", [], [])
    assert "first" in ctx
    assert "previous reply" in ctx
    assert "#ab12" in ctx and "media=2" in ctx
