#!/usr/bin/env python3
"""
Update version manifest with newly deployed artifact versions.

Accepts deployment metadata (via --from-metadata) and updates the manifest
only if the deployed version is newer than the existing one. Supports multiple
named artifacts per repository.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Type alias for the manifest structure
type Manifest = dict[str, Any]


def parse_version(version: str) -> tuple[int, ...]:
    """Parse a semantic version string into comparable tuple."""
    # Remove 'v' prefix if present
    version = version.lstrip("v")
    parts = version.split(".")
    return tuple(int(p) for p in parts)


def is_newer_version(new_version: str, current_version: str | None) -> bool:
    """
    Check if new_version is newer than current_version.

    Returns True if current_version is None or new_version > current_version.
    """
    if current_version is None:
        return True

    try:
        new_parsed = parse_version(new_version)
        current_parsed = parse_version(current_version)
    except ValueError:
        print(f"Warning: Could not parse versions ({new_version}, {current_version}), treating as older")
        return False
    else:
        return new_parsed > current_parsed


def update_manifest_image(
    manifest: Manifest,
    repo_name: str,
    artifact_name: str,
    version: str,
    repository: str,
    image_tag: str,
    commit_sha: str,
) -> bool:
    """
    Update manifest with a named Docker image artifact.

    Returns True if manifest was updated, False if skipped (version not newer).
    """
    repositories: dict[str, Any] = manifest.setdefault("repositories", {})
    current_repo: dict[str, Any] = repositories.setdefault(repo_name, {})
    images: dict[str, Any] = current_repo.setdefault("images", {})
    current_artifact: dict[str, Any] | None = images.get(artifact_name)
    current_version: str | None = current_artifact.get("version") if current_artifact else None

    if not is_newer_version(version, current_version):
        print(
            f"Skipping {repo_name}/{artifact_name} (image): deployed version {version} is not newer than "
            f"manifest version {current_version}"
        )
        return False

    images[artifact_name] = {
        "repository": repository,
        "imageTag": image_tag,
        "version": version,
        "commitSha": commit_sha,
    }
    print(f"Updated {repo_name}/{artifact_name} (image) from {current_version} to {version}")
    return True


def update_manifest_lambda(
    manifest: Manifest,
    repo_name: str,
    artifact_name: str,
    version: str,
    bucket: str,
    key: str,
    commit_sha: str,
) -> bool:
    """
    Update manifest with a named Lambda artifact.

    Returns True if manifest was updated, False if skipped (version not newer).
    """
    repositories: dict[str, Any] = manifest.setdefault("repositories", {})
    current_repo: dict[str, Any] = repositories.setdefault(repo_name, {})
    lambdas: dict[str, Any] = current_repo.setdefault("lambdas", {})
    current_artifact: dict[str, Any] | None = lambdas.get(artifact_name)
    current_version: str | None = current_artifact.get("version") if current_artifact else None

    if not is_newer_version(version, current_version):
        print(
            f"Skipping {repo_name}/{artifact_name} (lambda): deployed version {version} is not newer than "
            f"manifest version {current_version}"
        )
        return False

    lambdas[artifact_name] = {
        "bucket": bucket,
        "key": key,
        "version": version,
        "commitSha": commit_sha,
    }
    print(f"Updated {repo_name}/{artifact_name} (lambda) from {current_version} to {version}")
    return True


def main() -> int:
    """Update version manifest with deployment info."""
    parser = argparse.ArgumentParser(description="Update version manifest after artifact deployment")
    parser.add_argument(
        "--manifest-path",
        default=str(Path("version-manifests") / "latest.json"),
        help="Path to manifest file",
    )
    parser.add_argument("--from-metadata", required=True, help="Path to metadata JSON file")

    args = parser.parse_args()

    # Load metadata from file
    with Path(args.from_metadata).open() as f:
        metadata = json.load(f)

    # Validate required fields
    required_fields = ["repoName", "commitSha", "sourceRepo"]
    missing_fields = [field for field in required_fields if field not in metadata]
    if missing_fields:
        print(f"Error: Missing required fields in metadata: {', '.join(missing_fields)}")
        return 1

    repo_name = metadata["repoName"]
    commit_sha = metadata["commitSha"]
    source_repo = metadata["sourceRepo"]

    # Artifacts is a list of {name, type, ...type-specific fields}
    artifacts: list[dict[str, Any]] = metadata.get("artifacts", [])

    if not artifacts:
        print("Error: Metadata must contain a non-empty 'artifacts' list")
        return 1

    manifest_path = Path(args.manifest_path)

    # Load existing manifest
    manifest: Manifest
    if manifest_path.exists():
        with manifest_path.open() as f:
            manifest = json.load(f)
    else:
        manifest = {
            "$schema": "./version-manifest.schema.json",
            "schemaVersion": "2.0.0",
            "repositories": {},
        }

    # Ensure source repo is set at the repository level
    repositories: dict[str, Any] = manifest.setdefault("repositories", {})
    current_repo: dict[str, Any] = repositories.setdefault(repo_name, {})
    current_repo["source"] = source_repo

    updated = False

    for artifact in artifacts:
        a_name = artifact["name"]
        a_type = artifact["type"]

        a_version = artifact.get("version")
        if not a_version:
            print(f"Error: Artifact '{a_name}' missing required field 'version'")
            return 1

        if a_type == "image":
            repository_uri = artifact.get("repository")
            image_tag = artifact.get("imageTag")
            if not all([repository_uri, image_tag]):
                print(f"Error: Image artifact '{a_name}' missing required fields (repository, imageTag)")
                return 1
            updated |= update_manifest_image(
                manifest=manifest,
                repo_name=repo_name,
                artifact_name=a_name,
                version=a_version,
                repository=repository_uri,
                image_tag=image_tag,
                commit_sha=commit_sha,
            )
        elif a_type == "lambda":
            bucket = artifact.get("bucket")
            key = artifact.get("key")
            if not all([bucket, key]):
                print(f"Error: Lambda artifact '{a_name}' missing required fields (bucket, key)")
                return 1
            updated |= update_manifest_lambda(
                manifest=manifest,
                repo_name=repo_name,
                artifact_name=a_name,
                version=a_version,
                bucket=bucket,
                key=key,
                commit_sha=commit_sha,
            )
        else:
            print(f"Error: Unknown artifact type '{a_type}' for artifact '{a_name}'")
            return 1

    # Write output for GitHub Actions
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a") as f:
            f.write(f"updated={'true' if updated else 'false'}\n")

    if not updated:
        print("No updates made to manifest (version not newer)")
        return 0

    # Write updated manifest
    with manifest_path.open("w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"Successfully updated {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
