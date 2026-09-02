#!/usr/bin/env python3
"""
One-time codemod: migrates the light-theme Tailwind utility vocabulary used
across src/app and src/components to the new dark-navy design system's
semantic tokens (defined in src/app/globals.css's @theme block: surface-0..3,
ink/ink-secondary/ink-muted/ink-faint, hairline/hairline-strong).

First run excluded src/app/page.tsx and src/components/landing/* (hand-tuned
separately for the flagship marketing redesign); a second run then included
them too once the mechanical mapping proved solid across the rest of the app,
with a manual polish pass afterward on the landing page's few genuinely
bespoke moments (hero gradient, CTA banner, dashboard mockup chrome) that no
mechanical rule should touch.

Run with --dry-run first to see a per-file change count before writing.
"""
import re
import sys
import glob

COLORS = ["orange", "red", "amber", "green", "emerald", "sky", "blue", "purple", "teal", "pink"]

# Each rule: (base_class_regex_without_prefix, replacement_template)
# `{c}` in a template is substituted per color when the rule is generated
# per-color. Order matters: more specific / hover-aware rules must run
# BEFORE the general fallback rule for the same base class, since later
# rules only see whatever text earlier rules left behind.
RULES = []


def add(base_pattern, replacement):
    """base_pattern: regex for the exact utility token (no variant prefix,
    no leading colon) — e.g. r'bg-white(/\\d+)?'. Matches it anywhere a
    Tailwind class token can appear, preserving any variant-prefix chain
    (hover:, sm:, group-hover:, dark:, ...) verbatim before the swapped
    class, and any trailing opacity suffix is captured in group 2 (must be
    the LAST capturing group in base_pattern) if the pattern has one.
    """
    full = re.compile(r"(?<![\w:-])((?:[\w-]+:)*)" + base_pattern + r"(?![\w-])")
    RULES.append((full, replacement))


def add_hover_aware_text(color, dark_shade_default, dark_shade_hover, light_shades):
    """text-{color}-{light_shades} -> text-{color}-{dark_shade_hover} when the
    variant prefix chain contains hover/group-hover/focus, else
    text-{color}-{dark_shade_default}. Must be registered BEFORE the plain
    (non-hover-aware) rule for the same shades if one also exists — here we
    only ever add one rule per shade so ordering is naturally fine as long
    as this whole function runs before any later catch-all for the same
    shade (it doesn't currently duplicate).
    """
    shade_alt = "|".join(light_shades)

    def repl(m):
        prefix = m.group(1) or ""
        if re.search(r"(?:^|:)(hover|group-hover|focus)(?::|$)", prefix):
            return f"{prefix}text-{color}-{dark_shade_hover}"
        return f"{prefix}text-{color}-{dark_shade_default}"

    full = re.compile(r"(?<![\w:-])((?:[\w-]+:)*)text-" + color + r"-(?:" + shade_alt + r")(?![\w-])")
    RULES.append((full, repl))


# ---------------------------------------------------------------------------
# Neutral surfaces (backgrounds)
# ---------------------------------------------------------------------------
add(r"bg-white(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-2{m.group(2) or ''}")
add(r"bg-neutral-50(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-1{m.group(2) or ''}")
add(r"bg-neutral-100(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-1{m.group(2) or ''}")
add(r"bg-neutral-200(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-3{m.group(2) or ''}")
add(r"bg-neutral-300(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-3{m.group(2) or ''}")
add(r"bg-neutral-800(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-3{m.group(2) or ''}")
add(r"bg-neutral-900(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-0{m.group(2) or ''}")
add(r"bg-stone-50(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-1{m.group(2) or ''}")
add(r"bg-stone-100(/\d+)?", lambda m: f"{m.group(1) or ''}bg-surface-1{m.group(2) or ''}")

# ---------------------------------------------------------------------------
# Neutral text
# ---------------------------------------------------------------------------
add(r"text-neutral-900", lambda m: f"{m.group(1) or ''}text-ink")
add(r"text-neutral-800", lambda m: f"{m.group(1) or ''}text-ink")
add(r"text-neutral-700", lambda m: f"{m.group(1) or ''}text-ink-secondary")
add(r"text-neutral-600", lambda m: f"{m.group(1) or ''}text-ink-secondary")
add(r"text-neutral-500", lambda m: f"{m.group(1) or ''}text-ink-muted")
add(r"text-neutral-400", lambda m: f"{m.group(1) or ''}text-ink-faint")
add(r"text-neutral-300", lambda m: f"{m.group(1) or ''}text-ink-faint")
add(r"text-neutral-200", lambda m: f"{m.group(1) or ''}text-ink-faint")

# ---------------------------------------------------------------------------
# Neutral borders / dividers / rings / placeholder
# ---------------------------------------------------------------------------
add(r"border-neutral-100(/\d+)?", lambda m: f"{m.group(1) or ''}border-hairline/60")
add(r"border-neutral-200(/\d+)?", lambda m: f"{m.group(1) or ''}border-hairline")
add(r"border-neutral-300(/\d+)?", lambda m: f"{m.group(1) or ''}border-hairline-strong")
add(r"border-neutral-400(/\d+)?", lambda m: f"{m.group(1) or ''}border-hairline-strong")
add(r"border-neutral-900(/\d+)?", lambda m: f"{m.group(1) or ''}border-hairline-strong")
add(r"border-stone-200(/\d+)?", lambda m: f"{m.group(1) or ''}border-hairline")
add(r"border-stone-300(/\d+)?", lambda m: f"{m.group(1) or ''}border-hairline-strong")
add(r"divide-neutral-100", lambda m: f"{m.group(1) or ''}divide-hairline/60")
add(r"divide-neutral-200", lambda m: f"{m.group(1) or ''}divide-hairline")
add(r"ring-neutral-200", lambda m: f"{m.group(1) or ''}ring-hairline")
add(r"ring-neutral-900", lambda m: f"{m.group(1) or ''}ring-ink")
add(r"placeholder-neutral-400", lambda m: f"{m.group(1) or ''}placeholder-ink-faint")

# ---------------------------------------------------------------------------
# Colored status/accent badges — light-tint backgrounds and dark-shade text
# that worked on a white page need to become translucent-tint backgrounds
# and light-shade text that work on a near-black page. Solid, saturated
# shades used as real button/icon backgrounds (500/600) are left untouched
# — those already read fine on a dark surface.
# ---------------------------------------------------------------------------
for c in COLORS:
    add(rf"bg-{c}-50(/\d+)?", lambda m, c=c: f"{m.group(1) or ''}bg-{c}-500/15")
    add(rf"bg-{c}-100(/\d+)?", lambda m, c=c: f"{m.group(1) or ''}bg-{c}-500/20")
    add(rf"border-{c}-200(/\d+)?", lambda m, c=c: f"{m.group(1) or ''}border-{c}-500/30")
    add(rf"border-{c}-300(/\d+)?", lambda m, c=c: f"{m.group(1) or ''}border-{c}-500/40")
    # Hover/focus/group-hover variants of the darkest text tiers must map to
    # something LIGHTER than the plain-state mapping below (dark-theme
    # hover = brighten, not darken), so these run first.
    add_hover_aware_text(c, dark_shade_default="400", dark_shade_hover="300", light_shades=["700"])
    add_hover_aware_text(c, dark_shade_default="300", dark_shade_hover="200", light_shades=["800", "900"])
    add(rf"text-{c}-600", lambda m, c=c: f"{m.group(1) or ''}text-{c}-400")

FILES = [
    f
    for f in glob.glob("src/app/**/*.tsx", recursive=True) + glob.glob("src/components/**/*.tsx", recursive=True)
]

dry_run = "--dry-run" in sys.argv
total_changes = 0
changed_files = 0

for path in FILES:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    original = text
    file_changes = 0
    for regex, repl in RULES:
        text, n = regex.subn(repl, text)
        file_changes += n
    if file_changes:
        changed_files += 1
        total_changes += file_changes
        if not dry_run:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
        print(f"{file_changes:5d}  {path}")

print(f"\n{'[dry-run] ' if dry_run else ''}{changed_files} files, {total_changes} class substitutions")
