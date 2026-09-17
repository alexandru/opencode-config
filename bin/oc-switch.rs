#!/usr/bin/env -S cargo +nightly -q -Zscript
---cargo
[package]
edition = "2024"

[dependencies]
anyhow = "1"
clap = { version = "4", features = ["derive"] }
jsonc-parser = { version = "0.33", features = ["serde"] }
serde_json = { version = "1", features = ["preserve_order"] }
---

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use clap::Parser;
use jsonc_parser::{ParseOptions, parse_to_serde_value};
use serde_json::{Map, Value};

const COMMON_FILE: &str = "opencode.common.jsonc";
const PRESETS_FILE: &str = "opencode.presets.jsonc";
const OUTPUT_FILE: &str = "opencode.jsonc";

#[derive(Debug, Parser)]
#[command(
    name = "oc-switch",
    about = "Generate an OpenCode configuration from a preset",
    disable_help_flag = true
)]
struct Args {
    /// Preset to apply
    #[arg(value_name = "PRESET")]
    preset: Option<String>,

    /// Print help
    #[arg(short, long)]
    help: bool,
}

/// Loads the selected preset, merges it with the common configuration, and writes the result.
fn main() -> Result<()> {
    let args = Args::parse();
    let config_dir = config_dir()?;
    let presets = read_jsonc_object(&config_dir.join(PRESETS_FILE))?;

    let Some(preset_name) = args.preset.filter(|_| !args.help) else {
        print_help(&presets);
        return Ok(());
    };

    if !presets.contains_key(&preset_name) {
        bail!(
            "Preset '{preset_name}' not found in {PRESETS_FILE}\n\nAvailable presets:\n{}\n\nUsage: oc-switch <preset-name>",
            format_presets(&presets)
        );
    }

    let common = Value::Object(read_jsonc_object(&config_dir.join(COMMON_FILE))?);
    let preset = resolve_preset(&presets, &preset_name, &mut Vec::new())?;
    let merged = deep_merge(common, preset);

    write_json(&config_dir.join(OUTPUT_FILE), &merged)?;
    println!("✓ Successfully switched to preset: {preset_name}");
    println!("✓ Generated {OUTPUT_FILE}");
    print_agent_table(&merged);

    Ok(())
}

/// Returns the configuration directory containing this Cargo script's `bin` directory.
///
/// Cargo sets `CARGO_MANIFEST_DIR` to the directory containing the script, even when the
/// compiled script runs from Cargo's cache.
fn config_dir() -> Result<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .context("failed to locate the configuration directory")
}

/// Reads a JSONC file and requires its root value to be an object.
fn read_jsonc_object(path: &Path) -> Result<Map<String, Value>> {
    let content = fs::read_to_string(path).with_context(|| {
        if path.exists() {
            format!("failed to read {}", path.display())
        } else {
            format!("configuration file missing: {}", path.display())
        }
    })?;

    let value: Value = parse_to_serde_value(&content, &ParseOptions::default())
        .with_context(|| format!("failed to parse {}", path.display()))?;

    value
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("{} must contain a JSON object", path.display()))
}

/// Serializes a value as pretty-printed JSON with a trailing newline.
fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut content = serde_json::to_string_pretty(value).context("failed to serialize config")?;
    content.push('\n');
    fs::write(path, content).with_context(|| format!("failed to write {}", path.display()))
}

/// Resolves a preset and its ordered parent chain into one configuration object.
///
/// Later parents override earlier parents, and the selected preset overrides every parent.
/// `ancestors` tracks the active resolution path so inheritance cycles can be reported.
fn resolve_preset(
    presets: &Map<String, Value>,
    preset_name: &str,
    ancestors: &mut Vec<String>,
) -> Result<Value> {
    let preset = presets
        .get(preset_name)
        .ok_or_else(|| anyhow!("Preset '{preset_name}' not found in {PRESETS_FILE}"))?
        .as_object()
        .ok_or_else(|| anyhow!("Preset '{preset_name}' must be a JSON object"))?;

    if let Some(cycle_start) = ancestors.iter().position(|name| name == preset_name) {
        let mut cycle = ancestors[cycle_start..].to_vec();
        cycle.push(preset_name.to_owned());
        bail!(
            "Circular preset inheritance detected: {}",
            cycle.join(" -> ")
        );
    }

    let parent_names = match preset.get("extends") {
        None => return Ok(Value::Object(strip_preset_metadata(preset))),
        Some(Value::Array(names)) => names
            .iter()
            .map(|name| {
                name.as_str().ok_or_else(|| {
                    anyhow!(
                        "Preset '{preset_name}' has invalid 'extends'; expected an array of preset names."
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?,
        Some(_) => bail!(
            "Preset '{preset_name}' has invalid 'extends'; expected an array of preset names."
        ),
    };

    ancestors.push(preset_name.to_owned());
    let inherited =
        parent_names
            .into_iter()
            .try_fold(Value::Object(Map::new()), |merged, parent_name| {
                resolve_preset(presets, parent_name, ancestors)
                    .map(|parent| deep_merge(merged, parent))
            });
    ancestors.pop();

    Ok(deep_merge(
        inherited?,
        Value::Object(strip_preset_metadata(preset)),
    ))
}

/// Removes fields used by the preset system rather than by OpenCode itself.
fn strip_preset_metadata(preset: &Map<String, Value>) -> Map<String, Value> {
    let mut config = preset.clone();
    config.remove("common");
    config.remove("extends");
    config
}

/// Recursively merges two JSON values using the switcher's compatibility rules.
///
/// Objects merge recursively, arrays and primitive target values replace their source values,
/// and a target `null` retains the source value. These rules match the original Node.js script.
fn deep_merge(source: Value, target: Value) -> Value {
    match (source, target) {
        (source, Value::Null) => source,
        (Value::Null, target) => target,
        (Value::Object(mut source), Value::Object(target)) => {
            for (key, target_value) in target {
                match source.get_mut(&key) {
                    Some(source_value)
                        if is_object_like(source_value) && is_object_like(&target_value) =>
                    {
                        let original = std::mem::take(source_value);
                        *source_value = deep_merge(original, target_value);
                    }
                    _ => {
                        source.insert(key, target_value);
                    }
                }
            }
            Value::Object(source)
        }
        (_, target) => target,
    }
}

/// Reports whether a value participates in recursive object merging.
///
/// JSON `null` counts as object-like here to preserve the original JavaScript merge behavior.
fn is_object_like(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Null)
}

/// Iterates over presets that are available for direct selection.
///
/// Presets marked with `"common": true` remain available for inheritance but are hidden here.
fn visible_preset_names(presets: &Map<String, Value>) -> impl Iterator<Item = &str> {
    presets.iter().filter_map(|(name, preset)| {
        (preset.get("common") != Some(&Value::Bool(true))).then_some(name.as_str())
    })
}

/// Formats visible preset names for help and error output.
fn format_presets(presets: &Map<String, Value>) -> String {
    visible_preset_names(presets)
        .map(|name| format!("  - {name}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Prints usage information and the presets available for direct selection.
fn print_help(presets: &Map<String, Value>) {
    println!("OpenCode Configuration Preset Switcher\n");
    println!("Usage: oc-switch <preset-name>\n");
    println!("Available presets:\n{}\n", format_presets(presets));
    println!("Description:");
    println!("  Merges opencode.common.jsonc with the selected preset");
    println!("  from opencode.presets.jsonc to generate opencode.jsonc");
    println!("  Presets marked common: true are hidden from this list");
    println!("  and may be inherited with extends.");
}

/// Prints the configured agent, model, and variant mappings when any agents are present.
fn print_agent_table(config: &Value) {
    let Some(agents) = config.get("agent").and_then(Value::as_object) else {
        return;
    };
    if agents.is_empty() {
        return;
    }

    let rows = agents
        .iter()
        .map(|(name, config)| AgentRow {
            name,
            model: string_field(config, "model").unwrap_or("-"),
            variant: string_field(config, "variant").unwrap_or("-"),
        })
        .collect::<Vec<_>>();
    let agent_width = column_width("Agent", rows.iter().map(|row| row.name));
    let model_width = column_width("Model", rows.iter().map(|row| row.model));
    let variant_width = column_width("Variant", rows.iter().map(|row| row.variant));

    println!();
    println!(
        "  {0:<agent_width$} │ {1:<model_width$} │ Variant",
        "Agent", "Model"
    );
    println!(
        "  {}─┼─{}─┼─{}",
        "─".repeat(agent_width),
        "─".repeat(model_width),
        "─".repeat(variant_width)
    );
    for row in rows {
        println!(
            "  {name:<agent_width$} │ {model:<model_width$} │ {variant}",
            name = row.name,
            model = row.model,
            variant = row.variant
        );
    }
    println!();
}

struct AgentRow<'a> {
    name: &'a str,
    model: &'a str,
    variant: &'a str,
}

/// Returns the display width needed for a table column and its header.
fn column_width<'a>(header: &str, values: impl Iterator<Item = &'a str>) -> usize {
    values
        .map(|value| value.chars().count())
        .max()
        .unwrap_or(0)
        .max(header.chars().count())
}

/// Returns a string field from a JSON object, or `None` for any other shape or value type.
fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.as_object()?.get(key)?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deep_merge_merges_objects_and_replaces_arrays() {
        let source = json!({
            "nested": { "kept": true, "overridden": "old" },
            "items": [1, 2]
        });
        let target = json!({
            "nested": { "overridden": "new", "added": true },
            "items": [3]
        });

        let merged = deep_merge(source, target);

        assert_eq!(
            merged,
            json!({
                "nested": { "kept": true, "overridden": "new", "added": true },
                "items": [3]
            })
        );
    }

    #[test]
    fn resolve_preset_applies_parents_in_order_and_removes_metadata() -> Result<()> {
        let presets = json!({
            "base": { "common": true, "value": "base", "base_only": true },
            "second": { "common": true, "value": "second" },
            "selected": {
                "extends": ["base", "second"],
                "value": "selected"
            }
        });
        let presets = presets
            .as_object()
            .cloned()
            .context("test presets must be an object")?;

        let resolved = resolve_preset(&presets, "selected", &mut Vec::new())?;

        assert_eq!(resolved, json!({ "value": "selected", "base_only": true }));
        Ok(())
    }

    #[test]
    fn resolve_preset_rejects_inheritance_cycles() -> Result<()> {
        let presets = json!({
            "first": { "extends": ["second"] },
            "second": { "extends": ["first"] }
        });
        let presets = presets
            .as_object()
            .cloned()
            .context("test presets must be an object")?;

        let error = resolve_preset(&presets, "first", &mut Vec::new())
            .expect_err("inheritance cycle must fail");

        assert_eq!(
            error.to_string(),
            "Circular preset inheritance detected: first -> second -> first"
        );
        Ok(())
    }
}
