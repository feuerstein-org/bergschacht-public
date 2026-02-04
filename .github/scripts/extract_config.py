#!/usr/bin/env python3
"""Extract version and deployment config from a package's pyproject.toml."""

import argparse
import json
import os
import sys
import tomllib
from pathlib import Path


def main() -> int:
    """Extract config and write to GITHUB_OUTPUT."""
    parser = argparse.ArgumentParser(description="Extract deployment config from pyproject.toml")
    parser.add_argument("package", help="Package name (directory under packages/)")
    args = parser.parse_args()

    pyproject_path = Path("packages") / args.package / "pyproject.toml"

    with pyproject_path.open("rb") as f:
        config = tomllib.load(f)

    # Extract version (required)
    version = config["project"]["version"]
    print(f"Extracted version: {version}")

    # Extract deployment config with defaults
    bergschacht = config.get("tool", {}).get("bergschacht", {})
    deploy_types = bergschacht.get("deploy_types", ["docker"])
    print(f"Deploy types: {deploy_types}")

    # Write outputs
    github_output = os.environ.get("GITHUB_OUTPUT")
    if not github_output:
        print("GITHUB_OUTPUT not set, printing values only")
        return 0

    with Path(github_output).open("a") as f:
        f.write(f"version={version}\n")
        f.write(f"deploy_types={json.dumps(deploy_types)}\n")

        if "lambda" in deploy_types:
            lambda_function = bergschacht.get("lambda_function_name")
            if not lambda_function:
                print("::error::lambda_function_name is required in [tool.bergschacht] for Lambda deployments")
                return 1
            print(f"Lambda function: {lambda_function}")
            f.write(f"lambda_function_name={lambda_function}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
