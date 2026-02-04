#!/usr/bin/env python3
"""Categorize changed packages by deployment type."""

import argparse
import json
import os
import sys
import tomllib
from pathlib import Path


def main() -> int:
    """Categorize packages and write to GITHUB_OUTPUT."""
    parser = argparse.ArgumentParser(description="Categorize packages by deployment type")
    parser.add_argument("packages_json", help="JSON array of changed package names")
    args = parser.parse_args()

    changed = json.loads(args.packages_json)
    docker_packages: list[str] = []
    lambda_packages: list[str] = []
    package_versions: dict[str, str] = {}

    for pkg in changed:
        pyproject_path = Path("packages") / pkg / "pyproject.toml"
        with pyproject_path.open("rb") as f:
            config = tomllib.load(f)

        version = config["project"]["version"]
        package_versions[pkg] = version

        deploy_types = config.get("tool", {}).get("bergschacht", {}).get("deploy_types", ["docker"])

        if "docker" in deploy_types:
            docker_packages.append(pkg)
        if "lambda" in deploy_types:
            lambda_packages.append(pkg)

    print(f"Docker packages: {docker_packages}")
    print(f"Lambda packages: {lambda_packages}")
    print(f"Package versions: {package_versions}")

    github_output = os.environ.get("GITHUB_OUTPUT")
    if not github_output:
        print("GITHUB_OUTPUT not set, printing values only")
        return 0

    with Path(github_output).open("a") as f:
        f.write(f"docker_packages={json.dumps(docker_packages)}\n")
        f.write(f"lambda_packages={json.dumps(lambda_packages)}\n")
        f.write(f"package_versions={json.dumps(package_versions)}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
