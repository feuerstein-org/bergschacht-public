# Bergschacht

This repo deploys all of Feuersteins CDK infrastructure. The deployments are configured in such a way that specific branches are only allowed to push to specific accounts. For example the `dev` branch can only deploy to the dev account but the `master` branch can deploy to both dev and prod accounts.

## Getting started

To start developing simply install all the dependencies and get going. You can do that manually (by reviewing the mise file) or use [`mise`](https://mise.jdx.dev/getting-started.html) for that. Simply download it and run the below commands.

```bash
mise trust
mise run install # This will install pnpm, pre-commit etc.
# after that you can use pnpm to format, lint, build and test
pnpm run format
pnpm run lint:fix # or just lint to show the errors
pnpm run build
pnpm run watch # watch for changes and compile
pnpm run test
# Note that in CI all of the above will run
mise run pre-commit # will execute pre-commit (formatting/linting)
mise run test # will run pnpm run build & pnpm run test
```

Additionally you can run the CDK commands.

```bash
pnpm run cdk synth # emits the synthesized CloudFormation template
pnpm run cdk diff # compare deployed stack with current state
pnpm run cdk deploy # deploy to AWS
```

To run the full CI at once (format, lint, build, test and cdk synth) run the below

```bash
mise run test-full
```

> Note:
> `cdk diff` and `cdk deploy` requires permissions to the account. Since deployment for now goes through GitHub actions that wouldn't work. But if you have a ReadOnly permissions (or full permissions to the dev account) you can run these commands.

## Project Structure

- `lib/github-actions-stack.ts` - GitHub Actions OIDC authentication stack
- `lib/constants.ts` - Account mapping and other constants
- `bin/bergschacht.ts` - CDK app entry point with branch to account mapping

## Deployment Model

Deployments are controlled through GitHub Actions OIDC stacks that enforce branch-to-account permissions:

- **`master` branch** → deploys to Dev and Prod accounts
- **`dev` branch** → deploys to Dev account only

This means the branches specified here will have permissions to assume an OIDC role and make a deployment to the specified accounts.

After a change is deployed to a branch, Github actions will assume the OIDC role (deployed via this repo), then assume a role in the target account (currently the `cdk` role) and then perform the deployment.

This means that no changes from unapproved branches will go to production accounts while at the same time dev branches can deploy to dev accounts without hassle, e.g. no 2PR etc.

If you need to add a new account, branch or new branch-to-account mapping, see below.

## Stacks

### BergschachtGitHubActions

This stack sets up GitHub Actions to deploy CDK stacks using OIDC:

- Creates an OIDC identity provider for GitHub
- Configures necessary permissions for CDK deployments in other accounts

> Note: Only the master branch role itself has an additional permission (`iam:PassRole`) to allow deployments to the CI/CD account itself. If all roles would have it - this would allow someone to deploy changes to the CI/CD account and subsequently all other accounts without a 2PR.

Any time a new account requires deployments or a new branch needs to be deployed use this stack.

If you are adding a new account run `cdk bootstrap --trust <cicd-account-id> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess` to bootstrap the new account while allowing the CI/CD account to access it.

Then modify `lib/constants.ts` as well as `bin/bergschacht.ts` to specify what to deploy, finally add the aws account Id to GitHub secrets.
