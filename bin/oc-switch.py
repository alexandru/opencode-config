#!/usr/bin/env -S pipx run

# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "json5==0.17.3",
#   "typer==0.27.2",
# ]
# ///

"""Generate OpenCode's configuration file from a preset.

Merges opencode.common.jsonc with a preset from opencode.presets.jsonc and
writes opencode.jsonc. Presets inherit from other presets via "extends";
fragments marked "common": true stay hidden from direct selection.
"""

import json
import shutil
import subprocess
import sys
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, TypeAlias

import json5
import typer

COMMON_FILE = "opencode.common.jsonc"
PRESETS_FILE = "opencode.presets.jsonc"
OUTPUT_FILE = "opencode.jsonc"

CONFIG_DIR = Path(__file__).resolve().parent.parent

Json: TypeAlias = dict[str, "Json"] | list["Json"] | str | int | float | bool | None
JsonObject: TypeAlias = dict[str, Json]


class ConfigError(Exception):
    """A configuration problem, reported as one clear message, not a traceback."""


def merge_objects(source: JsonObject, target: JsonObject) -> JsonObject:
    """Target values win, shared objects merge recursively, a target null keeps
    the source object, and the result keeps the source's key order, then keys
    new in the target.
    """
    merged = dict(source)
    for key, target_value in target.items():
        source_value = merged.get(key)
        if isinstance(source_value, dict) and target_value is None:
            merged[key] = source_value
        elif isinstance(source_value, dict) and isinstance(target_value, dict):
            merged[key] = merge_objects(source_value, target_value)
        else:
            merged[key] = target_value
    return merged


def extends_names(preset: JsonObject, name: str) -> list[str]:
    extends = preset.get("extends")
    if extends is None:
        return []
    invalid = (
        f"Preset '{name}' has invalid 'extends'; expected an array of preset names."
    )
    if not isinstance(extends, list):
        raise ConfigError(invalid)
    names: list[str] = []
    for item in extends:
        if not isinstance(item, str):
            raise ConfigError(invalid)
        names.append(item)
    return names


def strip_preset_metadata(preset: JsonObject) -> JsonObject:
    """The preset as an OpenCode configuration, without the switcher's own keys."""
    return {
        key: value for key, value in preset.items() if key not in ("common", "extends")
    }


def resolve_preset(
    presets: JsonObject, name: str, ancestors: tuple[str, ...]
) -> JsonObject:
    """The preset with every "extends" parent merged in.

    Later parents override earlier ones, and the preset overrides its parents.
    `ancestors` is the resolution path, so inheritance cycles can be reported.
    """
    preset = presets.get(name)
    if preset is None:
        raise ConfigError(f"Preset '{name}' not found in {PRESETS_FILE}")
    if not isinstance(preset, dict):
        raise ConfigError(f"Preset '{name}' must be a JSON object")
    if name in ancestors:
        cycle = ancestors[ancestors.index(name) :] + (name,)
        raise ConfigError("Circular preset inheritance detected: " + " -> ".join(cycle))

    inherited: JsonObject = {}
    for parent in extends_names(preset, name):
        inherited = merge_objects(
            inherited, resolve_preset(presets, parent, (*ancestors, name))
        )
    return merge_objects(inherited, strip_preset_metadata(preset))


def read_jsonc_object(path: Path) -> JsonObject:
    """The root object of a JSONC file; configuration files must be objects."""
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise ConfigError(f"configuration file missing: {path}") from None
    except OSError as error:
        raise ConfigError(f"failed to read {path}: {error}") from None
    try:
        value = json5.loads(content)
    except ValueError as error:
        raise ConfigError(f"failed to parse {path}: {error}") from None
    if not isinstance(value, dict):
        raise ConfigError(f"{path} must contain a JSON object")
    return value


def write_json(path: Path, value: Json) -> None:
    """Pretty-printed JSON with a trailing newline."""
    content = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    try:
        path.write_text(content, encoding="utf-8")
    except OSError as error:
        raise ConfigError(f"failed to write {path}: {error}") from None


def reload_opencode() -> None:
    """Reloads a running OpenCode's configuration; a failed reload warns
    instead of failing the switch.
    """
    if shutil.which("opencode") is None:
        return
    status = subprocess.run(
        ["opencode", "service", "status"], capture_output=True, text=True, check=False
    )
    if not (status.stdout or "").strip().startswith("http"):
        return
    sys.stdout.flush()
    result = subprocess.run(["opencode", "reload"], check=False)
    if result.returncode != 0:
        print("⚠ opencode reload failed", file=sys.stderr)


def visible_preset_names(presets: JsonObject) -> Iterator[str]:
    """Presets selectable on the command line; "common": true fragments only get inherited."""
    for name, preset in presets.items():
        if not (isinstance(preset, dict) and preset.get("common") is True):
            yield name


def format_presets(presets: JsonObject) -> str:
    return "\n".join(f"  - {name}" for name in visible_preset_names(presets))


def print_help(presets: JsonObject) -> None:
    print("OpenCode Configuration Preset Switcher\n")
    print("Usage: oc-switch <preset-name>\n")
    print(f"Available presets:\n{format_presets(presets)}\n")
    print("Description:")
    print("  Merges opencode.common.jsonc with the selected preset")
    print("  from opencode.presets.jsonc to generate opencode.jsonc")
    print("  Presets marked common: true are hidden from this list")
    print("  and may be inherited with extends.")


@dataclass(frozen=True)
class AgentRow:
    name: str
    model: str
    variant: str


def is_disabled(config: Json) -> bool:
    return isinstance(config, dict) and config.get("disable") is True


def agent_field(config: Json, key: str) -> str:
    value = config.get(key) if isinstance(config, dict) else None
    return value if isinstance(value, str) else "-"


def agent_rows(agents: JsonObject) -> list[AgentRow]:
    return [
        AgentRow(
            name=name,
            model=agent_field(config, "model"),
            variant=agent_field(config, "variant"),
        )
        for name, config in agents.items()
        if not is_disabled(config)
    ]


def column_width(header: str, values: Iterable[str]) -> int:
    return max([len(header), *(len(value) for value in values)])


def format_agent_table(config: JsonObject) -> str | None:
    """The enabled agents and their model mappings, or None when none are configured."""
    agents = config.get("agent")
    if not isinstance(agents, dict):
        return None
    rows = agent_rows(agents)
    if not rows:
        return None

    name_width = column_width("Agent", (row.name for row in rows))
    model_width = column_width("Model", (row.model for row in rows))
    variant_width = column_width("Variant", (row.variant for row in rows))

    header = f"  {'Agent':<{name_width}} │ {'Model':<{model_width}} │ Variant"
    separator = f"  {'─' * name_width}─┼─{'─' * model_width}─┼─{'─' * variant_width}"
    body = "\n".join(
        f"  {row.name:<{name_width}} │ {row.model:<{model_width}} │ {row.variant}"
        for row in rows
    )
    return f"\n{header}\n{separator}\n{body}\n\n"


def switch(preset: str | None) -> None:
    """Generates opencode.jsonc from the selected preset, or prints help."""
    presets = read_jsonc_object(CONFIG_DIR / PRESETS_FILE)
    if preset is None:
        print_help(presets)
        return
    if preset not in presets:
        raise ConfigError(
            f"Preset '{preset}' not found in {PRESETS_FILE}\n\n"
            f"Available presets:\n{format_presets(presets)}\n\n"
            "Usage: oc-switch <preset-name>"
        )
    common = read_jsonc_object(CONFIG_DIR / COMMON_FILE)
    config = merge_objects(common, resolve_preset(presets, preset, ()))
    write_json(CONFIG_DIR / OUTPUT_FILE, config)
    print(f"✓ Successfully switched to preset: {preset}")
    print(f"✓ Generated {OUTPUT_FILE}")
    reload_opencode()
    table = format_agent_table(config)
    if table is not None:
        print(table, end="")


app = typer.Typer(add_completion=False, context_settings={"help_option_names": []})


@app.command()
def main(
    preset: Annotated[
        str | None, typer.Argument(metavar="PRESET", help="Preset to apply")
    ] = None,
    show_help: Annotated[bool, typer.Option("--help", "-h", help="Print help")] = False,
) -> None:
    """Generate an OpenCode configuration from a preset."""
    try:
        switch(None if show_help else preset)
    except ConfigError as error:
        print(f"Error: {error}", file=sys.stderr)
        raise typer.Exit(code=1) from None


if __name__ == "__main__":
    app()
