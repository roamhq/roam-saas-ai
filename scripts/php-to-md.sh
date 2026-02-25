#!/usr/bin/env bash
# Convert PHP source files to Markdown for AI Search (AutoRAG) indexing.
#
# Raw PHP produces weak embeddings for natural-language queries because
# embedding models match code syntax poorly against questions like
# "why aren't opening hours showing?". This script wraps each PHP file
# in Markdown with a natural-language preamble derived from the code
# itself (namespace, class name, class docblock, public methods).
#
# Usage:
#   scripts/php-to-md.sh <source-dir> <output-dir>
#
# Example:
#   scripts/php-to-md.sh src/Plugins/Roam/src _knowledge-base/core

set -euo pipefail

SOURCE_DIR="${1:?Usage: php-to-md.sh <source-dir> <output-dir>}"
OUTPUT_DIR="${2:?Usage: php-to-md.sh <source-dir> <output-dir>}"

mkdir -p "$OUTPUT_DIR"

find "$SOURCE_DIR" -type f -name "*.php" | while read -r src; do
  rel_path="${src#"$SOURCE_DIR"/}"
  filename=$(basename "$src")
  name="${filename%.php}"

  # Extract namespace
  namespace=$(grep -m1 '^namespace ' "$src" | sed 's/namespace //; s/;//' || true)

  # Extract class/trait/interface name (just the identifier)
  class_name=$(grep -m1 -E '^\s*(abstract )?(class|trait|interface) [A-Za-z]' "$src" \
    | awk '{for(i=1;i<=NF;i++){if($i~/^(class|trait|interface)$/){print $(i+1);exit}}}' || true)
  [ -z "$class_name" ] && class_name="$name"

  # Derive domain from namespace (segments after Roam\Plugins\Roam\)
  domain=$(echo "$namespace" | sed 's/.*\\Plugins\\Roam\\//' | tr '\\' '/')
  if [ -z "$domain" ]; then
    domain=$(dirname "$rel_path")
  fi

  # Extract class docblock: lines between /** and */ immediately before class declaration
  # Uses perl for reliable multiline matching (available on Ubuntu CI runners)
  class_doc=$(perl -0777 -ne '
    while (m{/\*\*(.*?)\*/\s*(?:abstract\s+)?class\s}sg) {
      my $block = $1;
      $block =~ s/^\s*\*\s?//mg;      # strip leading * markers
      $block =~ s/^\s*@.*$//mg;        # drop @annotations
      $block =~ s/^\s*\n//mg;          # drop blank lines
      print $block;
      last;
    }
  ' "$src" | head -6 || true)

  # Extract public method names (just the name, not full signature)
  methods=$(grep -E '^\s*public (static )?function ' "$src" \
    | awk '{for(i=1;i<=NF;i++){if($i=="function"){w=$(i+1);sub(/\(.*/,"",w);print w;break}}}' \
    | grep -v '__construct' \
    | head -15 \
    || true)

  # Title
  title="${class_name}"
  [ -n "$domain" ] && title="${class_name} - ${domain}"

  # Category description from top-level directory
  category=$(echo "$domain" | cut -d'/' -f1)
  case "$category" in
    services)    category_desc="PHP service" ;;
    formatters)  category_desc="PHP data formatter" ;;
    helpers)     category_desc="PHP helper utility" ;;
    models)      category_desc="PHP model" ;;
    records)     category_desc="PHP ActiveRecord model" ;;
    controllers) category_desc="PHP controller" ;;
    providers)   category_desc="PHP service provider" ;;
    *)           category_desc="PHP class" ;;
  esac

  # Output path preserves directory structure
  out_dir="${OUTPUT_DIR}/$(dirname "$rel_path")"
  out_file="${out_dir}/${filename}.md"
  mkdir -p "$out_dir"

  {
    echo "# ${title}"
    echo ""
    echo "This ${category_desc} is part of the Roam tourism platform (Craft CMS plugin)."

    if [ -n "$class_doc" ]; then
      echo ""
      echo "$class_doc"
    fi

    echo ""
    echo "**Source**: \`${rel_path}\`"
    echo "**Namespace**: \`${namespace}\`"

    if [ -n "$methods" ]; then
      echo ""
      echo "## Public methods"
      echo ""
      echo "$methods" | while read -r m; do
        echo "- \`${m}()\`"
      done
    fi

    echo ""
    echo "## Source code"
    echo ""
    echo '```php'
    cat "$src"
    echo '```'
  } > "$out_file"

  echo "  Converted: ${rel_path}"
done

echo "Total PHP files converted: $(find "$OUTPUT_DIR" -name '*.php.md' | wc -l | tr -d ' ')"
