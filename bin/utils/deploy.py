#!/usr/bin/env python3

"""Deploy a harness configuration checkout into its configuration directory.

Called by install.sh once Git, Python, and Make are available. The source is
either a fresh download or a local checkout; its Git index decides which files
are eligible, and their working-tree contents, symlinks, and executable modes
are what gets deployed.

The destination is handled by what it already is:

- the source itself: nothing to copy;
- a checkout of the same repository: a download fast-forwards it from its own
  upstream, and a local source only adds missing files, so its Git metadata and
  local changes stay intact;
- anything else (missing, empty, or holding runtime files): eligible files are
  added next to the existing ones, then Git metadata is installed last.

Existing files are never overwritten: a destination path holding different
content, or reached through a symlink, fails the whole deployment before any
change. Copies are atomic per file and identical files are skipped, so an
interrupted deployment can be rerun. Finally `make` runs in the destination.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

SourceKind = Literal["download", "checkout"]
MAX_LISTED_CONFLICTS = 20
SCP_LIKE_URL = re.compile(r"^(?:[^@/]+@)?([^:/]+):(?!//)(.*)$")
URL_WITH_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/]*@)?([^/:]+)(?::\d+)?(/.*)?$")


class DeployError(Exception):
    """A deployment problem, reported as one clear line rather than a traceback."""


@dataclass(frozen=True)
class RegularFile:
    content: bytes
    executable: bool


@dataclass(frozen=True)
class Symlink:
    target: str


Entry = RegularFile | Symlink


@dataclass(frozen=True)
class Deployable:
    path: PurePosixPath
    entry: Entry


def run_git(directory: Path, *arguments: str) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(directory), *arguments],
            check=False,
            stdin=subprocess.DEVNULL,
            capture_output=True,
        )
    except OSError as error:
        raise DeployError(f"cannot run git: {error.strerror or error}") from None
    if completed.returncode != 0:
        detail = completed.stderr.decode(errors="replace").strip().splitlines()
        reason = detail[-1] if detail else f"exit status {completed.returncode}"
        raise DeployError(f"git {' '.join(arguments)} failed in {directory}: {reason}")
    return completed.stdout.decode("utf-8", errors="surrogateescape")


def repository_identity(url: str) -> str:
    """Compare clone URLs by host and path, ignoring scheme, user, and `.git`."""
    text = url.strip()
    scheme = URL_WITH_SCHEME.match(text)
    if scheme is not None and not text.lower().startswith("file://"):
        identity = f"{scheme.group(1).lower()}/{(scheme.group(2) or '').lstrip('/')}"
    elif text.lower().startswith("file://"):
        identity = os.path.realpath(text[len("file://") :])
    elif os.path.isabs(text) or text.startswith("."):
        identity = os.path.realpath(text)
    else:
        scp = SCP_LIKE_URL.match(text)
        identity = (
            f"{scp.group(1).lower()}/{scp.group(2).lstrip('/')}" if scp else text
        )
    identity = identity.rstrip("/")
    return identity[: -len(".git")] if identity.endswith(".git") else identity


def checkout_root(directory: Path) -> Path:
    root = run_git(directory, "rev-parse", "--show-toplevel").strip()
    return Path(os.path.realpath(root))


def eligible_paths(source: Path) -> list[PurePosixPath]:
    """Paths in the source's Git index, the authority on what is deployable."""
    paths: dict[PurePosixPath, None] = {}
    for record in run_git(source, "ls-files", "-z", "--stage").split("\0"):
        if not record:
            continue
        metadata, _, name = record.partition("\t")
        mode, _, stage = metadata.split(" ")
        path = PurePosixPath(name)
        if stage != "0":
            raise DeployError(f"{source / path} has unresolved merge conflicts")
        if mode == "160000":
            raise DeployError(f"{source / path} is a Git submodule; not deployable")
        paths[path] = None
    return list(paths)


def read_entry(path: Path) -> Entry | None:
    try:
        status = path.lstat()
        if stat.S_ISLNK(status.st_mode):
            return Symlink(os.readlink(path))
        if stat.S_ISREG(status.st_mode):
            return RegularFile(path.read_bytes(), bool(status.st_mode & stat.S_IXUSR))
    except FileNotFoundError:
        return None
    except OSError as error:
        raise DeployError(f"cannot read {path}: {error.strerror or error}") from None
    raise DeployError(f"{path} is neither a regular file nor a symbolic link")


def deployables(source: Path) -> list[Deployable]:
    """Indexed files as they exist in the working tree; deleted ones are skipped."""
    found: list[Deployable] = []
    for path in eligible_paths(source):
        entry = read_entry(source.joinpath(*path.parts))
        if entry is not None:
            found.append(Deployable(path, entry))
    return found


def conflict(destination: Path, item: Deployable) -> str | None:
    """Why writing the item would change or escape existing destination content."""
    current = destination
    for part in item.path.parts[:-1]:
        current = current / part
        if current.is_symlink():
            return f"{current} is a symbolic link"
        if current.exists() and not current.is_dir():
            return f"{current} is not a directory"
    target = destination.joinpath(*item.path.parts)
    try:
        existing = read_entry(target)
    except DeployError:
        return f"{target} is neither a regular file nor a symbolic link"
    if existing is None:
        return None
    if isinstance(item.entry, Symlink) and isinstance(existing, Symlink):
        return None if existing.target == item.entry.target else f"{target} differs"
    if isinstance(item.entry, RegularFile) and isinstance(existing, RegularFile):
        return None if existing.content == item.entry.content else f"{target} differs"
    return f"{target} has a different file type"


def write_entry(target: Path, entry: Entry) -> None:
    """Replace the target atomically, so an interruption leaves no partial file."""
    existing = read_entry(target)
    if existing == entry:
        return
    if (
        isinstance(existing, RegularFile)
        and isinstance(entry, RegularFile)
        and existing.content == entry.content
    ):
        mode = stat.S_IMODE(target.lstat().st_mode)
        target.chmod(mode | 0o111 if entry.executable else mode & ~0o111)
        return

    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".install", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        if isinstance(entry, RegularFile):
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(entry.content)
            temporary.chmod(0o755 if entry.executable else 0o644)
        else:
            os.close(descriptor)
            temporary.unlink()
            os.symlink(entry.target, temporary)
        os.replace(temporary, target)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def copy_files(source: Path, destination: Path) -> None:
    items = deployables(source)
    conflicts = [reason for item in items if (reason := conflict(destination, item))]
    if conflicts:
        listed = "; ".join(conflicts[:MAX_LISTED_CONFLICTS])
        more = len(conflicts) - MAX_LISTED_CONFLICTS
        suffix = f"; and {more} more" if more > 0 else ""
        raise DeployError(
            f"refusing to overwrite existing files in {destination}: {listed}{suffix}"
        )
    try:
        for item in items:
            write_entry(destination.joinpath(*item.path.parts), item.entry)
    except OSError as error:
        raise DeployError(
            f"cannot write into {destination}: {error.strerror or error}"
        ) from None


def install_metadata(source: Path, repository: str, destination: Path) -> None:
    """Give the destination its own clone metadata, moved in as the final step."""
    try:
        staging = Path(tempfile.mkdtemp(prefix=".git-install.", dir=destination))
    except OSError as error:
        raise DeployError(
            f"cannot write into {destination}: {error.strerror or error}"
        ) from None
    try:
        clone = staging / "clone"
        run_git(staging, "clone", "--quiet", "--no-checkout", "--no-hardlinks", str(source), str(clone))
        run_git(clone, "remote", "set-url", "origin", repository)
        run_git(clone, "config", "--local", "status.showUntrackedFiles", "no")
        run_git(clone, "read-tree", "HEAD")
        try:
            os.rename(clone / ".git", destination / ".git")
        except OSError as error:
            raise DeployError(
                f"cannot install Git metadata in {destination}: {error.strerror or error}"
            ) from None
        run_git(destination, "update-index", "-q", "--refresh")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def update_checkout(destination: Path) -> None:
    try:
        run_git(destination, "pull", "--ff-only", "--quiet")
    except DeployError as error:
        raise DeployError(
            f"cannot fast-forward the existing checkout {destination}; "
            f"resolve it with git and rerun ({error})"
        ) from None


def prepare_destination(destination: Path) -> None:
    if destination.is_dir():
        return
    if destination.exists() or destination.is_symlink():
        raise DeployError(f"{destination} exists and is not a directory")
    try:
        destination.mkdir(parents=True)
    except OSError as error:
        raise DeployError(
            f"cannot create {destination}: {error.strerror or error}"
        ) from None


def deploy(
    source: Path, source_kind: SourceKind, repository: str, destination: Path
) -> None:
    if checkout_root(source) != Path(os.path.realpath(source)):
        raise DeployError(f"{source} is not the root of a Git checkout")
    prepare_destination(destination)
    if os.path.samefile(source, destination):
        print(f"Using the checkout in {destination}")
        return

    metadata = destination / ".git"
    if not (metadata.exists() or metadata.is_symlink()):
        print(f"Deploying into {destination}")
        copy_files(source, destination)
        install_metadata(source, repository, destination)
        return

    if checkout_root(destination) != Path(os.path.realpath(destination)):
        raise DeployError(f"{metadata} exists but is not a Git checkout's metadata")
    origin = run_git(destination, "config", "--get", "remote.origin.url").strip() or None
    if origin is None or repository_identity(origin) != repository_identity(repository):
        raise DeployError(
            f"{destination} is a Git checkout of {origin or 'an unknown repository'}, "
            f"not {repository}"
        )
    if source_kind == "checkout":
        print(f"Deploying into the checkout in {destination}")
        copy_files(source, destination)
        return
    print(f"Updating the checkout in {destination}")
    update_checkout(destination)


def run_make(destination: Path) -> None:
    try:
        status = subprocess.run(["make"], cwd=destination, check=False).returncode
    except OSError as error:
        raise DeployError(f"cannot run make: {error.strerror or error}") from None
    if status != 0:
        raise DeployError(f"make failed in {destination} with exit status {status}")


def parse_arguments(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="deploy", description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--source-kind", required=True, choices=("download", "checkout"))
    parser.add_argument("--repository", required=True)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--directory-variable", required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    arguments = parse_arguments(argv)
    source = Path(os.path.abspath(arguments.source))
    destination = Path(os.path.abspath(os.path.expanduser(arguments.destination)))
    source_kind: SourceKind = "download" if arguments.source_kind == "download" else "checkout"
    try:
        deploy(source, source_kind, arguments.repository, destination)
        run_make(destination)
    except DeployError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Error: interrupted; rerun the installer to finish", file=sys.stderr)
        return 130

    print(f"Installed into {destination}")
    variable = arguments.directory_variable
    if variable in os.environ:
        print(f"{variable} is set; export it from your shell startup files too.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
