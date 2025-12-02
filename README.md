# Bergschacht

This repo deploys all of Feuersteins CDK infrastructure. The deployments are configured in such a way that specific branches are only allowed to push to specific accounts. For example the `dev` branch can only deploy to the dev account but the `master` branch can deploy to both dev and prod accounts.

## Getting started

### Installing dependencies

To start developing simply install all the dependencies and get going. You can do that manually (by reviewing the `mise.toml` file) or use [`mise`](https://mise.jdx.dev/getting-started.html) for that. Simply download it and run the below commands.

```bash
mise trust
mise run install # This will install pnpm, pre-commit etc.
```

### Environment variables

Environment variables are also managed with `mise` if you decide to not use it, review the `mise.toml` file. `mise.toml` should hold the same values as they are present in the github environment variables this is enough to both synthesize and diff the stacks (`cdk synth` and `cdk diff`).

You can also override the values by creating a local `mise.local.toml` file which will overwrite the `mise.toml` env files. This file is excluded from version control and is only for local development - all local env variables or secrets can be set there. See `mise.local.example.toml` for the formatting.

> Note: you can find the "real" env variable values in GitHub variables.

### Development

After that you can use `pnpm` to format, lint, build and test. Alternatively you can also use `mise` tasks which under will use `pnpm` under the hood.

```bash
# Note that in CI all of the below will run
pnpm run format
pnpm run lint:fix # or just lint to show the errors
pnpm run build
pnpm run watch # watch for changes and compile
pnpm run test

mise run pre-commit # will execute pre-commit (formatting/linting)
mise run test # will run pnpm run build & pnpm run test
```

Additionally you can run the CDK commands.

```bash
pnpm run cdk synth # emits the synthesized CloudFormation template
pnpm run cdk diff # compare deployed stack with current state
pnpm run cdk deploy # deploy to AWS
```

Or with mise, which will also run build, test, format etc.

```bash
mise run test-full # You can also pass a Stack name to see the CFN
mise run synth # will not run tests/lint/formatting, you can pass a Stack name to see the CFN
mise run synth # same as above but for diff, you can pass a Stack name to see the CFN
```

To see all available `mise` tasks run `mise run`.

> Note:
> `cdk diff` and `cdk deploy` requires permissions to the account. Since deployment for now goes through GitHub actions that wouldn't work. But if you have a ReadOnly permissions (or full permissions to the dev account) you can run these commands.

## Project Structure

- `lib/github-oidc-provider-stack.ts` - GitHub OIDC provider stack to CI/CD account
- `lib/github-actions-stack.ts` - GitHub Actions IAM role stack also deployed to CI/CD account - allows deployment into Prod & Dev accounts
- `lib/readonly-role-stack.ts` - ReadOnly IAM role stack deployed to each account for monitoring and inspection
- `lib/constants.ts` - Account mapping and other constants
- `bin/bergschacht.ts` - CDK app entry point with branch to account mapping

## Deployment Model

Deployments are controlled through GitHub Actions OIDC stacks that enforce branch-to-account permissions:

- **`master` branch** → deploys to Dev, Prod and CI/CD accounts
- **Pull requests** → deploy to Dev account only (if tests and pre-commit checks pass)

This means the branches specified here will have permissions to assume an OIDC role and make a deployment to the specified accounts. GitHub Actions will deploy stacks to the specific accounts based on their postfix: `*Cicd`, `*Dev` or `*Prod`. If a stack doesn't have a postfix it wont be deployed.

**Important**: Any push to a branch with a pull request open will trigger a deployment to the Dev account, provided that the tests and pre-commit checks pass successfully.

Deployments to CI/CD and Prod will only happen from the `master` branch. This means that no changes from unapproved branches will go to production accounts while at the same time branches besides `master` can deploy to dev accounts without hassle, e.g. no 2PR etc.

This has the potential of causing issues later where different branches deploy changes to the dev account and break each other. In that case we would need to either create more accounts for testing or deploy to the dev account only through a specific `dev` branch.

If you need to add a new account, branch or new branch-to-account mapping, see below.

## Stacks

### GitHubOIDCProviderCicd

This stack creates the GitHub OIDC provider in the CI/CD account:

This needs to be deployed only once to the CI/CD account, then `GitHubActionsStack` instances deploy roles that allow GitHub actions to assume roles and deploy to other accoutns. The OIDC provider is then shared across all GitHub Actions roles in that account.

### GitHubActions

This stack sets up GitHub Actions to deploy CDK stacks using OIDC:

- Creates IAM roles that trust the GitHub OIDC provider
- Configures trust policies to restrict access to specific GitHub repositories and branches
- Configures necessary permissions for CDK deployments in other accounts

Any time a new account requires deployments or a new branch needs to be deployed use this stack.

If you are adding a new account run `cdk bootstrap --trust <cicd-account-id> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess` to bootstrap the new account while allowing the CI/CD account to access it.

Then modify `lib/constants.ts` as well as `bin/bergschacht.ts` to specify what to deploy, finally add the aws account Id to GitHub secrets.

### ReadOnlyRole

This stack creates a read-only IAM role in each account (CI/CD, Dev, Prod) that can be assumed by the CI/CD account:

- Creates an IAM role with AWS managed `ReadOnlyAccess` policy
- Allows the CI/CD account (and GitHubActions roles) to assume the role for monitoring and inspection
- If needed new ARNs can be added to trusted entities
