#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const commentJson = require("comment-json");

// File paths relative to script execution directory
const COMMON_FILE = "opencode.common.jsonc";
const PRESETS_FILE = "opencode.presets.jsonc";
const OUTPUT_FILE = "opencode.jsonc";
const PRESET_METADATA_KEYS = new Set(["common", "extends"]);

/**
 * Copy object with all symbols (including comment metadata)
 */
function copyWithSymbols(obj) {
  // Use Object.assign to copy enumerable properties
  const result = Object.assign({}, obj);

  // Also copy symbol properties (used by comment-json for metadata)
  const symbols = Object.getOwnPropertySymbols(obj);
  symbols.forEach((sym) => {
    result[sym] = obj[sym];
  });

  return result;
}

/**
 * Deep merge two objects with comment preservation
 * - Objects are merged recursively
 * - Arrays are replaced (not merged)
 * - Primitives from target override source
 * - Comments from source are preserved where possible
 */
function deepMerge(source, target) {
  if (target === null || target === undefined) {
    return source;
  }

  if (source === null || source === undefined) {
    return target;
  }

  // Arrays are replaced, not merged
  if (Array.isArray(target)) {
    return target;
  }

  // If target is not an object, it replaces source
  if (typeof target !== "object") {
    return target;
  }

  // If source is not an object but target is, use target
  if (typeof source !== "object" || Array.isArray(source)) {
    return target;
  }

  // Both are objects - deep merge with comment preservation
  const result = copyWithSymbols(source);

  for (const key in target) {
    if (target.hasOwnProperty(key)) {
      if (
        result.hasOwnProperty(key) &&
        typeof result[key] === "object" &&
        !Array.isArray(result[key]) &&
        typeof target[key] === "object" &&
        !Array.isArray(target[key])
      ) {
        // Recursively merge nested objects
        result[key] = deepMerge(result[key], target[key]);
      } else {
        // Replace value
        result[key] = target[key];
      }
    }
  }

  return result;
}

/**
 * Strip keys that are meaningful only to oc-switch and invalid in opencode config.
 */
function stripPresetMetadata(config) {
  const result = copyWithSymbols(config);
  for (const key of PRESET_METADATA_KEYS) {
    delete result[key];
  }
  return result;
}

/**
 * Resolve a preset's inheritance chain.
 */
function resolvePreset(presets, presetName, seen = []) {
  if (!Object.prototype.hasOwnProperty.call(presets, presetName)) {
    console.error(`Error: Preset '${presetName}' not found in ${PRESETS_FILE}`);
    process.exit(1);
  }

  if (seen.includes(presetName)) {
    console.error(
      `Error: Circular preset inheritance detected: ${seen.concat(presetName).join(" -> ")}`
    );
    process.exit(1);
  }

  const preset = presets[presetName];
  const parentNames = preset.extends;
  if (parentNames === undefined) {
    return stripPresetMetadata(preset);
  }

  if (
    !Array.isArray(parentNames) ||
    parentNames.some((parentName) => typeof parentName !== "string")
  ) {
    console.error(
      `Error: Preset '${presetName}' has invalid 'extends'; expected an array of preset names.`
    );
    process.exit(1);
  }

  const nextSeen = seen.concat(presetName);
  const inherited = parentNames.reduce(
    (merged, parentName) =>
      deepMerge(merged, resolvePreset(presets, parentName, nextSeen)),
    {}
  );
  return stripPresetMetadata(deepMerge(inherited, preset));
}

/**
 * Read and parse a JSONC file
 */
function readJsoncFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return commentJson.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(`Error: Configuration file missing: ${filePath}`);
      console.error("Please ensure the file exists in the current directory.");
      process.exit(1);
    } else {
      console.error(`Error: Failed to parse ${filePath}`);
      console.error(error.message);
      process.exit(1);
    }
  }
}

/**
 * Write JSONC file with preserved comments
 */
function writeJsoncFile(filePath, data) {
  try {
    const content = commentJson.stringify(data, null, 2) + "\n";
    fs.writeFileSync(filePath, content, "utf8");
  } catch (error) {
    console.error(`Error: Failed to write ${filePath}`);
    console.error(error.message);
    process.exit(1);
  }
}

/**
 * List available presets
 */
function listPresets(presets) {
  const presetNames = Object.keys(presets).filter(
    (name) => presets[name].common !== true
  );
  return presetNames.map((name) => `  - ${name}`).join("\n");
}

/**
 * Show help message
 */
function showHelp(presets) {
  console.log("OpenCode Configuration Preset Switcher");
  console.log("");
  console.log("Usage: oc-switch <preset-name>");
  console.log("");
  console.log("Available presets:");
  console.log(listPresets(presets));
  console.log("");
  console.log("Description:");
  console.log("  Merges opencode.common.jsonc with the selected preset");
  console.log("  from opencode.presets.jsonc to generate opencode.jsonc");
  console.log("  Presets marked common: true are hidden from this list");
  console.log("  and may be inherited with extends.");
}

/**
 * Main execution
 */
function main() {
  const args = process.argv.slice(2);

  // Load presets file first to show in help
  const presets = readJsoncFile(PRESETS_FILE);

  // Show help if no arguments
  if (args.length === 0) {
    showHelp(presets);
    process.exit(0);
  }

  const presetName = args[0];

  // Check if preset exists
  if (!presets.hasOwnProperty(presetName)) {
    console.error(`Error: Preset '${presetName}' not found in ${PRESETS_FILE}`);
    console.error("");
    console.error("Available presets:");
    console.error(listPresets(presets));
    console.error("");
    console.error("Usage: oc-switch <preset-name>");
    process.exit(1);
  }

  // Load common configuration
  const common = readJsoncFile(COMMON_FILE);

  // Get selected preset, including any inherited preset config
  const preset = resolvePreset(presets, presetName);

  // Merge configurations
  const merged = deepMerge(common, preset);

  // Write output file
  writeJsoncFile(OUTPUT_FILE, merged);

  console.log(`✓ Successfully switched to preset: ${presetName}`);
  console.log(`✓ Generated ${OUTPUT_FILE}`);

  // Print agent-to-model summary table
  const agents = merged.agent;
  if (agents && typeof agents === "object" && !Array.isArray(agents)) {
    const entries = Object.entries(agents);
    if (entries.length > 0) {
      // Determine column widths from the data
      const agentWidth = Math.max(...entries.map(([k]) => k.length), 7);
      const modelWidth = Math.max(...entries.map(([, v]) => (v.model || "").length), 5);
      const variantWidth = Math.max(
        ...entries.map(([, v]) => (v.variant || "-").length),
        7
      );

      const pad = (s, w) => s.padEnd(w);

      console.log("");
      console.log(
        `  ${pad("Agent", agentWidth)} │ ${pad("Model", modelWidth)} │ Variant`
      );
      console.log(
        `  ${"─".repeat(agentWidth)}─┼─${"─".repeat(modelWidth)}─┼─${"─".repeat(variantWidth)}`
      );
      for (const [name, cfg] of entries) {
        const model = cfg.model || "-";
        const variant = cfg.variant || "-";
        console.log(
          `  ${pad(name, agentWidth)} │ ${pad(model, modelWidth)} │ ${variant}`
        );
      }
      console.log("");
    }
  }
}

// Run
main();
