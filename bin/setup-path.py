#!/usr/bin/env python3

"""Persist Cellar's launcher directory in the user's bash and zsh startup files.

The launcher directory comes from the first `cellar` executable on PATH, with
the executable's symlinks left unresolved so a coursier cache implementation
path is never persisted. Only existing startup files receive a guarded PATH snippet that
prepends the directory only when an exact colon-delimited entry is absent.

Existing PATH configuration is recognized conservatively: literal `$HOME`,
quoted or escaped tilde prefixes, temporary environment-prefix assignments, and
unsupported shell syntax do not count. The rendered snippet leaves no empty
PATH entry when PATH is unset or empty.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import sys
from collections.abc import Sequence
from pathlib import Path

MARKER = "# Cellar CLI (added by setup-path)"
RC_NAMES = (".bashrc", ".zshrc")

DECLARATIONS = frozenset({"export", "declare", "typeset", "readonly"})
HOME_REFERENCE = re.compile(r"\$\{HOME\}|\$HOME(?![A-Za-z0-9_])")
ENTRY_TILDE = re.compile(r"(?:^|:)~")
ZSH_PATH_ARRAY = re.compile(
    r"^[ \t]*path\+?=[ \t]*\((.*?)\)[ \t]*(?:#[^\n]*)?$",
    re.MULTILINE | re.DOTALL,
)


class SetupPathError(Exception):
    """A setup problem, reported as one clear line rather than a traceback."""


def home_directory() -> Path:
    configured = os.environ.get("HOME")
    if configured:
        return Path(os.path.abspath(configured))
    try:
        return Path.home()
    except RuntimeError:
        raise SetupPathError("cannot determine HOME directory") from None


def cellar_launcher_directory() -> Path:
    launcher = shutil.which("cellar")
    if launcher is None:
        raise SetupPathError(
            "cellar not found on PATH; install Cellar before updating shell PATHs"
        )
    return Path(os.path.abspath(launcher)).parent


def relative_to_home(directory: Path, home: Path) -> Path | None:
    try:
        return directory.relative_to(home)
    except ValueError:
        return None


def location_expression(directory: Path, home: Path) -> str:
    """A shell word for the directory, using $HOME when the path is below it."""
    relative = relative_to_home(directory, home)
    if relative is not None:
        if not relative.parts:
            return '"$HOME"'
        relative_text = "/".join(relative.parts)
        if re.fullmatch(r"[A-Za-z0-9._/+,@%=-]+", relative_text):
            return f'"$HOME/{relative_text}"'
        return '"$HOME"/' + shlex.quote(relative_text)
    return shlex.quote(str(directory))


def render_block(directory: Path, home: Path) -> str:
    location = location_expression(directory, home)
    return (
        f"{MARKER}\n"
        'case ":${PATH-}:" in\n'
        f"  *:{location}:*) ;;\n"
        f'  *) export PATH={location}"${{PATH:+:$PATH}}" ;;\n'
        "esac\n"
    )


def has_literal_reference(raw: str, values: Sequence[str], array: bool) -> bool:
    """Reject literal or escaped HOME and quoted or escaped tilde prefixes."""
    has_home = any("$HOME" in value or "${HOME}" in value for value in values)
    if has_home and ("'" in raw or "\\" in raw):
        return True
    if "\\~" in raw:
        return True
    if ("'" in raw or '"' in raw) and (
        any(value.startswith("~") for value in values)
        if array
        else any(ENTRY_TILDE.search(value) is not None for value in values)
    ):
        return True
    return False


def expand_entry(entry: str, home: Path) -> str | None:
    """Expand only HOME/${HOME} and a leading unquoted tilde."""
    if not entry:
        return None
    text = entry
    if text == "~" or text.startswith("~/"):
        text = str(home) + text[1:]

    def replace_home(_match: re.Match[str]) -> str:
        return str(home)

    text = HOME_REFERENCE.sub(replace_home, text)
    if "$" in text or "`" in text or not os.path.isabs(text):
        return None
    return os.path.normpath(text)


def path_matches(value: str, target: str, home: Path) -> bool:
    for entry in value.split(":"):
        if expand_entry(entry, home) == target:
            return True
    return False


def standalone_path_value(tokens: Sequence[str]) -> str | None:
    """The value of a lone PATH= word, optionally after a declaration."""
    words = iter(tokens)
    word = next(words, None)
    if word in DECLARATIONS:
        word = next(words, None)
        while word is not None and word.startswith("-"):
            word = next(words, None)
    if word is None or next(words, None) is not None:
        return None
    if not word.startswith("PATH="):
        return None
    return word[len("PATH=") :]


def split_path_tokens(line: str) -> list[str]:
    """Tokenize an ordinary PATH line, splitting adjacent shell operators."""
    lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = "#"
    return list(lexer)


def array_matches(body: str, target: str, home: Path) -> bool:
    if any(character in body for character in "();&|<>"):
        return False
    if any("\n" not in body[match.end() :] for match in re.finditer("#", body)):
        return False
    try:
        elements = shlex.split(body, comments=True)
    except ValueError:
        return False
    if not elements or has_literal_reference(body, elements, array=True):
        return False
    for element in elements:
        if expand_entry(element, home) == target:
            return True
    return False


def mask_spans(text: str, spans: Sequence[tuple[int, int]]) -> str:
    characters = list(text)
    for start, end in spans:
        for index in range(start, end):
            if characters[index] not in "\r\n":
                characters[index] = " "
    return "".join(characters)


def has_active_path(text: str, directory: Path, home: Path) -> bool:
    if render_block(directory, home) in text:
        return True
    target = os.path.normpath(str(directory))

    arrays = list(ZSH_PATH_ARRAY.finditer(text))
    for match in arrays:
        if array_matches(match.group(1), target, home):
            return True

    path_text = re.sub(r"\\\r?\n", "", mask_spans(text, [m.span() for m in arrays]))
    for line in path_text.splitlines():
        try:
            tokens = split_path_tokens(line)
        except ValueError:
            continue
        value = standalone_path_value(tokens)
        if value is None or has_literal_reference(line, [value], array=False):
            continue
        if path_matches(value, target, home):
            return True
    return False


def update_file(
    path: Path, block: str, directory: Path, home: Path
) -> bool | None:
    try:
        content = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise SetupPathError(
            f"cannot read {path}: {error.strerror or error}"
        ) from None

    text = content.decode("utf-8", errors="surrogateescape")
    if has_active_path(text, directory, home):
        return False

    separator = b"\n" if content and not content.endswith(b"\n") else b""
    payload = separator + block.encode("utf-8", errors="surrogateescape")
    try:
        with path.open("ab") as handle:
            handle.write(payload)
    except OSError as error:
        raise SetupPathError(
            f"cannot update {path}: {error.strerror or error}"
        ) from None
    return True


def main(argv: Sequence[str]) -> int:
    try:
        if argv:
            raise SetupPathError("setup-path takes no arguments")
        home = home_directory()
        directory = cellar_launcher_directory()
        block = render_block(directory, home)
        updated: list[Path] = []
        existing: list[Path] = []
        for name in RC_NAMES:
            path = home / name
            if not path.exists():
                continue
            updated_file = update_file(path, block, directory, home)
            if updated_file is True:
                updated.append(path)
            elif updated_file is False:
                existing.append(path)
    except SetupPathError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    for path in updated:
        print(f"Added {directory} to PATH in {path}")
    for path in existing:
        print(f"{path} already configures {directory} on PATH")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
