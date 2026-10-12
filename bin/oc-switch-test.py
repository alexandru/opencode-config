#!/usr/bin/env -S pipx run

# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "json5==0.17.3",
#   "typer==0.27.2",
# ]
# ///

"""Unit tests for oc-switch. Run: make test-oc-switch

The pins mirror oc-switch.py's PEP 723 metadata, because importing the tool
module imports those packages.
"""

import importlib.util
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest import mock

TOOL_PATH = Path(__file__).resolve().parent / "oc-switch.py"


def load_tool() -> ModuleType:
    """Imports oc-switch.py; its dashed file name needs an explicit file load."""
    spec = importlib.util.spec_from_file_location("oc_switch", TOOL_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {TOOL_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = load_tool()


class MergeTest(unittest.TestCase):
    def test_merges_objects_and_replaces_arrays(self) -> None:
        source = {"nested": {"kept": True, "overridden": "old"}, "items": [1, 2]}
        target = {"nested": {"overridden": "new", "added": True}, "items": [3]}
        self.assertEqual(
            tool.merge_objects(source, target),
            {
                "nested": {"kept": True, "overridden": "new", "added": True},
                "items": [3],
            },
        )

    def test_null_never_wipes_a_source_object(self) -> None:
        source = {"http": {"methods": ["GET"]}}
        self.assertEqual(tool.merge_objects(source, {"http": None}), source)
        self.assertEqual(tool.merge_values(None, source), source)
        self.assertEqual(tool.merge_values(source, None), source)


class ResolvePresetTest(unittest.TestCase):
    def test_applies_parents_in_order_and_removes_metadata(self) -> None:
        presets = {
            "base": {"common": True, "value": "base", "base_only": True},
            "second": {"common": True, "value": "second"},
            "selected": {"extends": ["base", "second"], "value": "selected"},
        }
        self.assertEqual(
            tool.resolve_preset(presets, "selected", ()),
            {"value": "selected", "base_only": True},
        )

    def test_rejects_inheritance_cycles(self) -> None:
        presets = {"first": {"extends": ["second"]}, "second": {"extends": ["first"]}}
        with self.assertRaises(tool.ConfigError) as raised:
            tool.resolve_preset(presets, "first", ())
        self.assertEqual(
            str(raised.exception),
            "Circular preset inheritance detected: first -> second -> first",
        )


class AgentTableTest(unittest.TestCase):
    def test_omits_disabled_agents(self) -> None:
        config = {
            "agent": {
                "ask": {"disable": True},
                "Orchestrator": {"model": "opencode-go/mimo-v2.6-pro"},
                "Explorer": {
                    "model": "opencode-go/deepseek-v4.1-flash",
                    "variant": "low",
                },
            }
        }
        table = tool.format_agent_table(config)
        self.assertIsNotNone(table)
        assert table is not None
        self.assertNotIn("ask", table)
        self.assertIn("Orchestrator", table)
        self.assertIn("Explorer", table)

    def test_without_agents_there_is_no_table(self) -> None:
        self.assertIsNone(
            tool.format_agent_table({"model": "opencode-go/mimo-v2.6-pro"})
        )


class ReadJsoncTest(unittest.TestCase):
    def test_reads_comments_and_trailing_commas(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.jsonc"
            path.write_text('{\n  // fragment\n  "enabled": true,\n}', encoding="utf-8")
            self.assertEqual(tool.read_jsonc_object(path), {"enabled": True})

    def test_rejects_non_object_roots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.jsonc"
            path.write_text("[1]", encoding="utf-8")
            with self.assertRaises(tool.ConfigError):
                tool.read_jsonc_object(path)


class ReloadTest(unittest.TestCase):
    def test_skips_when_opencode_is_not_on_path(self) -> None:
        with (
            mock.patch.object(tool.shutil, "which", return_value=None),
            mock.patch.object(tool.subprocess, "run") as run,
        ):
            tool.reload_opencode()
        run.assert_not_called()

    def test_skips_when_no_service_is_running(self) -> None:
        stopped = subprocess.CompletedProcess[str](
            args=["opencode", "service", "status"], returncode=0, stdout="stopped\n"
        )
        with (
            mock.patch.object(tool.shutil, "which", return_value="/usr/bin/opencode"),
            mock.patch.object(tool.subprocess, "run", side_effect=[stopped]) as run,
        ):
            tool.reload_opencode()
        self.assertEqual(run.call_count, 1)

    def test_skips_on_unexpected_status_output(self) -> None:
        empty = subprocess.CompletedProcess[str](args=[], returncode=1, stdout=None)
        with (
            mock.patch.object(tool.shutil, "which", return_value="/usr/bin/opencode"),
            mock.patch.object(tool.subprocess, "run", side_effect=[empty]) as run,
        ):
            tool.reload_opencode()
        self.assertEqual(run.call_count, 1)

    def test_failed_reload_warns_without_failing(self) -> None:
        running = subprocess.CompletedProcess[str](
            args=["opencode", "service", "status"],
            returncode=0,
            stdout="http://127.0.0.1:49374\n",
        )
        failed = subprocess.CompletedProcess[str](
            args=["opencode", "reload"], returncode=1
        )
        stderr = io.StringIO()
        with (
            mock.patch.object(tool.shutil, "which", return_value="/usr/bin/opencode"),
            mock.patch.object(
                tool.subprocess, "run", side_effect=[running, failed]
            ) as run,
            mock.patch("sys.stderr", stderr),
        ):
            tool.reload_opencode()
        self.assertEqual(run.call_count, 2)
        self.assertIn("opencode reload failed", stderr.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
