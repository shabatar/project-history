"""Tests for shared model-aware token budgeting and hierarchical merge."""

from app.services import llm_budget
from app.services import summary_service


class TestEstimateTokens:
    def test_empty_is_at_least_one(self):
        assert llm_budget.estimate_tokens("") == 1

    def test_scales_with_length(self):
        assert llm_budget.estimate_tokens("a" * 400) == 100


class TestInputTokenBudget:
    def test_normal_reserves_headroom(self):
        assert llm_budget.input_token_budget(8192) == 6392

    def test_floor_applied_for_small_context(self):
        assert llm_budget.input_token_budget(2048) == llm_budget.MIN_BUDGET_TOKENS

    def test_cap_applied_for_huge_context(self):
        assert llm_budget.input_token_budget(131072) == llm_budget.MAX_BUDGET_TOKENS

    def test_custom_floor_overrides(self):
        assert llm_budget.input_token_budget(4096, floor=3200) == 3200


class TestResolveContextSize:
    async def test_uses_ollama_value(self, monkeypatch):
        from app.services import ollama_service

        async def fake_ctx(model):
            return 16384
        monkeypatch.setattr(ollama_service, "get_context_size", fake_ctx)
        assert await llm_budget.resolve_context_size("m") == 16384

    async def test_falls_back_on_error(self, monkeypatch):
        from app.services import ollama_service

        async def boom(model):
            raise RuntimeError("ollama down")
        monkeypatch.setattr(ollama_service, "get_context_size", boom)
        assert await llm_budget.resolve_context_size("m") == llm_budget.DEFAULT_CONTEXT_TOKENS

    async def test_falls_back_on_zero(self, monkeypatch):
        from app.services import ollama_service

        async def zero(model):
            return 0
        monkeypatch.setattr(ollama_service, "get_context_size", zero)
        assert await llm_budget.resolve_context_size("m") == llm_budget.DEFAULT_CONTEXT_TOKENS


class TestBatchByTokenBudget:
    def test_groups_within_budget(self):
        items = ["x" * 100] * 5
        batches = summary_service._batch_by_token_budget(items, 60)
        assert [len(b) for b in batches] == [2, 2, 1]

    def test_single_item_always_its_own_batch_when_over_budget(self):
        items = ["x" * 1000, "y" * 1000]
        batches = summary_service._batch_by_token_budget(items, 10)
        assert [len(b) for b in batches] == [1, 1]

    def test_all_fit_one_batch(self):
        items = ["short", "tiny"]
        batches = summary_service._batch_by_token_budget(items, 10_000)
        assert len(batches) == 1


class TestMergePartials:
    async def test_single_partial_returned_verbatim(self):
        out = await summary_service._merge_partials(
            ["only one"], repo_name="r", start_label="a", end_label="b",
            model="m", token_budget=1000,
        )
        assert out == "only one"

    async def test_empty_returns_empty(self):
        out = await summary_service._merge_partials(
            [], repo_name="r", start_label="a", end_label="b", model="m", token_budget=1000,
        )
        assert out == ""

    async def test_hierarchical_reduction_to_one(self, monkeypatch):
        calls = {"n": 0}

        async def fake_generate(prompt, model=None):
            calls["n"] += 1
            return "MERGED"

        monkeypatch.setattr(summary_service.ollama_service, "generate", fake_generate)
        partials = ["a" * 100, "b" * 100, "c" * 100, "d" * 100]
        out = await summary_service._merge_partials(
            partials, repo_name="r", start_label="a", end_label="b",
            model="m", token_budget=60,
        )
        assert out == "MERGED"
        assert calls["n"] >= 2

    async def test_oversized_partials_still_make_progress(self, monkeypatch):
        async def fake_generate(prompt, model=None):
            return "M"

        monkeypatch.setattr(summary_service.ollama_service, "generate", fake_generate)
        partials = ["x" * 1000, "y" * 1000, "z" * 1000]
        out = await summary_service._merge_partials(
            partials, repo_name="r", start_label="a", end_label="b",
            model="m", token_budget=1,
        )
        assert out == "M"
