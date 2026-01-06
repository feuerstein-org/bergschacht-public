#!/usr/bin/env python3
"""
Update version manifest with newly deployed package versions.

Pass deployment details as arguments, and the script will update the
manifest only if the deployed version is newer than the existing one.
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
        return new_parsed > current_parsed
    except ValueError:
        print(f"Warning: Could not parse versions ({new_version}, {current_version}), treating as older")
        return False


def update_manifest_docker(
    manifest: Manifest,
    package_name: str,
    version: str,
    repository: str,
    image_tag: str,
    commit_sha: str,
) -> bool:
    """
    Update manifest with Docker image deployment info.

    Returns True if manifest was updated, False if skipped (version not newer).
    """
    packages: dict[str, Any] = manifest.setdefault("packages", {})
    current_pkg: dict[str, Any] = packages.setdefault(package_name, {})
    current_image: dict[str, Any] | None = current_pkg.get("image")
    current_version: str | None = current_image.get("version") if current_image else None

    if not is_newer_version(version, current_version):
        print(
            f"Skipping {package_name} (image): deployed version {version} is not newer than manifest version {current_version}"
        )
        return False

    current_pkg["image"] = {
        "repository": repository,
        "imageTag": image_tag,
        "version": version,
        "commitSha": commit_sha,
    }
    print(f"Updated {package_name} (image) from {current_version} to {version}")
    return True


def update_manifest_lambda(
    manifest: Manifest,
    package_name: str,
    version: str,
    bucket: str,
    key: str,
    commit_sha: str,
) -> bool:
    """
    Update manifest with Lambda deployment info.

    Returns True if manifest was updated, False if skipped (version not newer).
    """
    packages: dict[str, Any] = manifest.setdefault("packages", {})
    current_pkg: dict[str, Any] = packages.setdefault(package_name, {})
    current_lambda: dict[str, Any] | None = current_pkg.get("lambda")
    current_version: str | None = current_lambda.get("version") if current_lambda else None

    if not is_newer_version(version, current_version):
        print(
            f"Skipping {package_name} (lambda): deployed version {version} is not newer than manifest version {current_version}"
        )
        return False

    current_pkg["lambda"] = {
        "bucket": bucket,
        "key": key,
        "version": version,
        "commitSha": commit_sha,
    }
    print(f"Updated {package_name} (lambda) from {current_version} to {version}")
    return True


def main() -> int:
    """Update version manifest with deployment info."""
    parser = argparse.ArgumentParser(description="Update version manifest after package deployment")
    parser.add_argument("--manifest-path", default="version-manifests/latest.json", help="Path to manifest file")
    parser.add_argument("--from-metadata", required=True, help="Path to metadata JSON file")

    args = parser.parse_args()

    # Load metadata from file
    with open(args.from_metadata) as f:
        metadata = json.load(f)

    # Validate required fields
    required_fields = ["type", "packageName", "version", "commitSha"]
    missing_fields = [field for field in required_fields if field not in metadata]
    if missing_fields:
        print(f"Error: Missing required fields in metadata: {', '.join(missing_fields)}")
        return 1

    deploy_type = metadata["type"]
    package_name = metadata["packageName"]
    version = metadata["version"]
    commit_sha = metadata["commitSha"]

    # Extract type-specific fields
    repository = metadata.get("repository")
    image_tag = metadata.get("imageTag")
    bucket = metadata.get("bucket")
    key = metadata.get("key")

    manifest_path = Path(args.manifest_path)

    # Load existing manifest
    manifest: Manifest
    if manifest_path.exists():
        with open(manifest_path) as f:
            manifest = json.load(f)
    else:
        manifest = {
            "$schema": "./version-manifest.schema.json",
            "schemaVersion": "1.0.0",
            "packages": {},
        }

    # Update based on deployment type
    if deploy_type == "docker":
        if not all([repository, image_tag]):
            print("Error: Docker metadata missing required fields")
            return 1
        updated = update_manifest_docker(
            manifest=manifest,
            package_name=package_name,
            version=version,
            repository=repository,
            image_tag=image_tag,
            commit_sha=commit_sha,
        )
    else:  # lambda
        if not all([bucket, key]):
            print("Error: Lambda metadata missing required fields")
            return 1
        updated = update_manifest_lambda(
            manifest=manifest,
            package_name=package_name,
            version=version,
            bucket=bucket,
            key=key,
            commit_sha=commit_sha,
        )

    # Write output for GitHub Actions
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"updated={'true' if updated else 'false'}\n")

    if not updated:
        print("No updates made to manifest (version not newer)")
        return 0

    # Write updated manifest
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print(f"Successfully updated {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
