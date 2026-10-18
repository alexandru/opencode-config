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
import json
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

    def test_null_targets_keep_source_objects_and_replace_scalars(self) -> None:
        source = {"nested": {"kept": True}, "replaced": "source"}
        target = {"nested": None, "replaced": None}

        merged = tool.merge_objects(source, target)

        self.assertEqual(merged, {"nested": {"kept": True}, "replaced": None})


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
            "agents": {
                "ask": {"disabled": True},
                "Orchestrator": {"model": "opencode-go/mimo-v2.6-pro"},
                "Explorer": {"model": "opencode-go/deepseek-v4.1-flash#low"},
            }
        }
        table = tool.format_agent_table(config)
        self.assertIsNotNone(table)
        assert table is not None
        self.assertNotIn("ask", table)
        self.assertNotIn("#", table)
        self.assertEqual(
            table,
            "\n"
            "  Agent        │ Model                           │ Variant\n"
            "  ─────────────┼─────────────────────────────────┼────────\n"
            "  Orchestrator │ opencode-go/mimo-v2.6-pro       │ -\n"
            "  Explorer     │ opencode-go/deepseek-v4.1-flash │ low\n"
            "\n",
        )

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

    def test_successful_reload_prints_a_status_line(self) -> None:
        running = subprocess.CompletedProcess[str](
            args=["opencode", "service", "status"],
            returncode=0,
            stdout="http://127.0.0.1:49374\n",
        )
        reloaded = subprocess.CompletedProcess[str](
            args=["opencode", "reload"], returncode=0
        )
        stdout = io.StringIO()
        with (
            mock.patch.object(tool.shutil, "which", return_value="/usr/bin/opencode"),
            mock.patch.object(tool.subprocess, "run", side_effect=[running, reloaded]),
            mock.patch("sys.stdout", stdout),
        ):
            tool.reload_opencode()
        self.assertIn("✓ Configuration reloaded", stdout.getvalue())

    def test_failed_reload_forwards_child_errors_and_warns(self) -> None:
        running = subprocess.CompletedProcess[str](
            args=["opencode", "service", "status"],
            returncode=0,
            stdout="http://127.0.0.1:49374\n",
        )
        failed = subprocess.CompletedProcess[str](
            args=["opencode", "reload"], returncode=1, stderr="Could not reload\n"
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
        self.assertIn("Could not reload", stderr.getvalue())
        self.assertIn("opencode reload failed", stderr.getvalue())


class SwitchTest(unittest.TestCase):
    def test_switches_native_v2_presets_with_docker_mcp_overrides(self) -> None:
        common = {
            "permissions": [
                {"action": "external_directory", "resource": "*", "effect": "deny"},
                {
                    "action": "external_directory",
                    "resource": "~/.agents/skills/**",
                    "effect": "allow",
                },
            ],
            "agents": {
                "ask": {"disabled": True},
                "build": {"disabled": True},
            },
            "mcp": {
                "servers": {
                    "mcp-metals": {
                        "type": "remote",
                        "url": "http://localhost:8083/mcp",
                        "disabled": True,
                        "codemode": False,
                    },
                    "mcp-playwright": {
                        "type": "local",
                        "command": ["npx", "-y", "@playwright/mcp@latest"],
                        "disabled": True,
                        "codemode": False,
                    },
                }
            },
        }
        presets = {
            "base": {
                "model": "opencode-go/mimo-v2.6-pro",
                "agents": {
                    "Orchestrator": {"model": "opencode-go/mimo-v2.6-pro"},
                    "Junior": {"model": "opencode-go/deepseek-v4.1-flash#high"},
                },
            },
            "w-common": {
                "common": True,
                "mcp": {
                    "servers": {
                        "mcp-metals": {
                            "url": "http://host.docker.internal:8083/mcp",
                            "headers": {"Host": "localhost:8083"},
                        },
                        "mcp-playwright": {
                            "command": [
                                "npx",
                                "-y",
                                "@playwright/mcp@latest",
                                "--cdp-endpoint=http://host.docker.internal:9222",
                            ],
                        },
                    }
                },
            },
            "w-go": {"extends": ["w-common", "base"]},
        }
        with tempfile.TemporaryDirectory() as tmp:
            config_dir = Path(tmp)
            (config_dir / tool.COMMON_FILE).write_text(
                json.dumps(common), encoding="utf-8"
            )
            (config_dir / tool.PRESETS_FILE).write_text(
                json.dumps(presets), encoding="utf-8"
            )
            stdout = io.StringIO()
            with (
                mock.patch.object(tool, "CONFIG_DIR", config_dir),
                mock.patch.object(tool, "reload_opencode") as reload,
                mock.patch("sys.stdout", stdout),
            ):
                tool.switch("w-go")
            reload.assert_called_once_with()
            written = json.loads(
                (config_dir / tool.OUTPUT_FILE).read_text(encoding="utf-8")
            )

        self.assertEqual(
            written["agents"],
            {
                "ask": {"disabled": True},
                "build": {"disabled": True},
                "Orchestrator": {"model": "opencode-go/mimo-v2.6-pro"},
                "Junior": {"model": "opencode-go/deepseek-v4.1-flash#high"},
            },
        )
        self.assertEqual(
            written["permissions"],
            [
                {"action": "external_directory", "resource": "*", "effect": "deny"},
                {
                    "action": "external_directory",
                    "resource": "~/.agents/skills/**",
                    "effect": "allow",
                },
            ],
        )
        self.assertEqual(written["model"], "opencode-go/mimo-v2.6-pro")
        self.assertNotIn("common", written)
        self.assertNotIn("extends", written)
        self.assertEqual(
            written["mcp"]["servers"]["mcp-metals"],
            {
                "type": "remote",
                "url": "http://host.docker.internal:8083/mcp",
                "disabled": True,
                "codemode": False,
                "headers": {"Host": "localhost:8083"},
            },
        )
        self.assertEqual(
            written["mcp"]["servers"]["mcp-playwright"],
            {
                "type": "local",
                "command": [
                    "npx",
                    "-y",
                    "@playwright/mcp@latest",
                    "--cdp-endpoint=http://host.docker.internal:9222",
                ],
                "disabled": True,
                "codemode": False,
            },
        )
        self.assertEqual(
            stdout.getvalue(),
            "✓ Successfully switched to preset: w-go\n"
            "✓ Generated opencode.jsonc\n"
            "\n"
            "  Agent        │ Model                           │ Variant\n"
            "  ─────────────┼─────────────────────────────────┼────────\n"
            "  Orchestrator │ opencode-go/mimo-v2.6-pro       │ -\n"
            "  Junior       │ opencode-go/deepseek-v4.1-flash │ high\n"
            "\n",
        )


CONFIG_DIR = Path(__file__).resolve().parent.parent

EXPECTED_AGENTS = frozenset(
    {"Orchestrator", "Solo", "Analyst", "Junior", "Explorer", "Librarian"}
)


class PresetsFileTest(unittest.TestCase):
    """Validates the real opencode.presets.jsonc, not synthetic fixtures."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.presets = tool.read_jsonc_object(CONFIG_DIR / tool.PRESETS_FILE)

    def test_every_visible_preset_resolves(self) -> None:
        for name in tool.visible_preset_names(self.presets):
            with self.subTest(preset=name):
                resolved = tool.resolve_preset(self.presets, name, ())
                self.assertIsInstance(resolved, dict)

    def test_default_preset_resolves(self) -> None:
        resolved = tool.resolve_preset(self.presets, "default", ())
        self.assertIsInstance(resolved, dict)

    def test_every_visible_preset_covers_all_agents(self) -> None:
        for name in tool.visible_preset_names(self.presets):
            with self.subTest(preset=name):
                resolved = tool.resolve_preset(self.presets, name, ())
                agents = resolved.get("agents")
                self.assertIsInstance(agents, dict, f"preset '{name}' has no agents")
                configured = {
                    agent
                    for agent, config in agents.items()
                    if isinstance(config, dict)
                    and config.get("disabled") is not True
                    and isinstance(config.get("model"), str)
                }
                missing = EXPECTED_AGENTS - configured
                self.assertFalse(
                    missing,
                    f"preset '{name}' is missing model assignments for: "
                    f"{sorted(missing)}",
                )

    def test_w_presets_extend_w_common(self) -> None:
        for name, preset in self.presets.items():
            if not name.startswith("w-") or name == "w-common":
                continue
            if not isinstance(preset, dict):
                continue
            extends = preset.get("extends")
            self.assertIsInstance(extends, list, f"preset '{name}' has no extends")
            assert isinstance(extends, list)
            self.assertIn(
                "w-common",
                extends,
                f"preset '{name}' does not extend 'w-common'",
            )

    def test_no_preset_extends_missing_target(self) -> None:
        for name, preset in self.presets.items():
            if not isinstance(preset, dict):
                continue
            for parent in tool.extends_names(preset, name):
                self.assertIn(
                    parent,
                    self.presets,
                    f"preset '{name}' extends missing preset '{parent}'",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
