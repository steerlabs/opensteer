# Security

## Supported Versions

Security fixes target the latest released version of Opensteer.

## Reporting a Vulnerability

Please do not open public issues for vulnerabilities.

Email security reports to `tim@opensteer.com` with:

- a short description;
- affected version or commit;
- reproduction steps;
- impact;
- any known workaround.

We will acknowledge reports as soon as practical and follow up with next steps.

## Sensitive Data

Never commit:

- API keys, tokens, passwords, or private keys;
- `.env` files;
- browser profiles;
- cookies, session storage, local storage, or login databases;
- Opensteer runtime workspaces such as `.opensteer/`;
- local agent state such as `.claude/`;
- generated dependency folders such as `node_modules/` or `.venv/`.

## Runtime Boundaries

Opensteer can control browsers and run local Python code. Only run code and
agent tools you trust. Keep secrets in the local environment or a secret manager,
not in the repository.
